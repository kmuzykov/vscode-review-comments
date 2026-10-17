import * as vscode from 'vscode';
import { CommentStorage, StorageBrokenError } from './storage';
import { StoredThread, USER_AUTHOR, generateId, lastAuthor, renamedPath, shiftRangeByEdits } from './model';

const CONTROLLER_ID = 'review-comments';

/**
 * Read-only snapshots that can carry the same threads as the working file, as long as their text
 * is identical to the file on disk (so line numbers agree). `git:` is what VS Code's own diff and
 * branch-compare editors use for the committed side.
 */
const ALIAS_SCHEMES = new Set(['git']);

/**
 * A thread's contextValue is what the `commentThread` key in package.json `when` clauses sees,
 * so it carries the resolved state as well as the storage ID: "resolved:<id>" or "unresolved:<id>".
 */
function threadContext(id: string, resolved: boolean): string {
    return `${resolved ? 'resolved' : 'unresolved'}:${id}`;
}

/** Extract the storage ID from a thread's contextValue. */
function threadIdOf(thread: vscode.CommentThread): string | undefined {
    const value = thread.contextValue;
    if (!value)
        return undefined;
    const sep = value.indexOf(':');
    return sep === -1 ? value : value.substring(sep + 1);
}

function threadLabel(stored: StoredThread): string {
    if (stored.resolved)
        return 'Resolved';
    const last = lastAuthor(stored);
    return last === USER_AUTHOR ? 'Open' : `Open · ${last} replied`;
}

function bodyText(body: string | vscode.MarkdownString): string {
    return typeof body === 'string' ? body : body.value;
}

function markdown(text: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString(text);
    md.isTrusted = false;
    md.supportHtml = false;
    return md;
}

/** A comment as shown in the editor; remembers its thread and its saved text for edit/cancel. */
class ReviewComment implements vscode.Comment {
    savedBody: string;
    body: string | vscode.MarkdownString;
    mode: vscode.CommentMode = vscode.CommentMode.Preview;
    author: vscode.CommentAuthorInformation;
    timestamp?: Date;
    contextValue?: string;

    constructor(readonly id: string, readonly threadId: string, body: string, author: string, timestamp?: string) {
        this.savedBody = body;
        this.body = markdown(body);
        this.author = { name: author };
        const t = timestamp ? new Date(timestamp) : undefined;
        this.timestamp = t && !isNaN(t.getTime()) ? t : undefined;
    }

    get editing(): boolean {
        return this.mode === vscode.CommentMode.Editing;
    }

    sameAs(id: string, body: string, author: string): boolean {
        return this.id === id && this.savedBody === body && this.author.name === author;
    }
}

/** One stored thread and the editor threads showing it: the working file plus any matching snapshots. */
interface Entry {
    views: Map<string, vscode.CommentThread>;
    shown?: StoredThread;
}

/**
 * Maps between the comments file and VS Code comment threads.
 * The file is the single source of truth; `reconcile()` brings the editor in line with it by
 * updating threads in place, so drafts, edits in progress and collapsed state survive the agent
 * rewriting the file.
 */
export class ReviewCommentController {
    private readonly controller: vscode.CommentController;
    private readonly entries = new Map<string, Entry>();
    /** Snapshot documents (by URI string) that match a workspace file, mapped to its relative path. */
    private readonly aliases = new Map<string, { filePath: string; version: number }>();
    /** Ranges moved by unsaved edits in the editor, by thread id; written to the file on save. */
    private readonly liveRanges = new Map<string, { startLine: number; endLine: number }>();
    private readonly cleanChecks = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly disposables: vscode.Disposable[] = [];
    private refreshing: Promise<void> = Promise.resolve();
    private readonly _onDidChangeThreads = new vscode.EventEmitter<void>();
    readonly onDidChangeThreads = this._onDidChangeThreads.event;

    constructor(private readonly storage: CommentStorage) {
        this.controller = vscode.comments.createCommentController(CONTROLLER_ID, 'Review Comments');
        this.controller.options = { placeHolder: 'Write a review comment…', prompt: 'Add a review comment' };
        this.controller.commentingRangeProvider = {
            provideCommentingRanges: async (document: vscode.TextDocument) => {
                if (!(await this.isCommentable(document)))
                    return [];
                return [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)];
            }
        };

        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(e => this.onDocumentEdited(e)),
            vscode.workspace.onDidSaveTextDocument(d => this.onDocumentSaved(d)),
            vscode.workspace.onDidCloseTextDocument(d => this.onDocumentClosed(d)),
            vscode.workspace.onDidOpenTextDocument(d => { if (ALIAS_SCHEMES.has(d.uri.scheme)) this.refresh(); }),
            vscode.workspace.onDidRenameFiles(e => this.onFilesRenamed(e)),
        );
    }

    // ---- what can be commented on -------------------------------------------------------------

    /** Workspace-relative path a document's comments belong to, or undefined if it cannot have any. */
    filePathFor(uri: vscode.Uri): string | undefined {
        if (uri.scheme === 'file') {
            if (uri.toString() === this.storage.uri.toString())
                return undefined;
            const rel = this.storage.relativePath(uri);
            return rel && !rel.startsWith('.git/') ? rel : undefined;
        }
        return this.aliases.get(uri.toString())?.filePath;
    }

    private async isCommentable(document: vscode.TextDocument): Promise<boolean> {
        if (ALIAS_SCHEMES.has(document.uri.scheme))
            return (await this.checkAlias(document)) !== undefined;
        return this.filePathFor(document.uri) !== undefined;
    }

    /** A snapshot is an alias of a workspace file when its text equals the file on disk. */
    private async checkAlias(document: vscode.TextDocument): Promise<string | undefined> {
        const key = document.uri.toString();
        const rel = this.storage.relativePath(vscode.Uri.file(document.uri.fsPath));
        let match = false;
        if (rel) {
            try {
                const disk = new TextDecoder().decode(await vscode.workspace.fs.readFile(this.storage.resolveUri(rel)));
                match = normaliseEol(disk) === normaliseEol(document.getText());
            } catch {
                match = false;
            }
        }
        if (match && rel)
            this.aliases.set(key, { filePath: rel, version: document.version });
        else
            this.aliases.delete(key);
        return match ? rel : undefined;
    }

    private async refreshAliases(onlyFile?: string): Promise<void> {
        const open = new Set<string>();
        for (const doc of vscode.workspace.textDocuments) {
            if (!ALIAS_SCHEMES.has(doc.uri.scheme))
                continue;
            open.add(doc.uri.toString());
            const known = this.aliases.get(doc.uri.toString());
            if (onlyFile !== undefined && known && known.filePath !== onlyFile)
                continue;
            await this.checkAlias(doc);
        }
        for (const key of [...this.aliases.keys()])
            if (!open.has(key))
                this.aliases.delete(key);
    }

    // ---- syncing the editor with the file -----------------------------------------------------

    /** Re-check snapshot documents, then reconcile. Calls are serialised. */
    refresh(onlyFile?: string): Promise<void> {
        this.refreshing = this.refreshing.then(async () => {
            await this.refreshAliases(onlyFile);
            this.reconcile();
        }).catch(e => console.error('[review-comments] refresh failed', e));
        return this.refreshing;
    }

    /** Called when the file changed on disk: forget unsaved range moves for threads the file now places. */
    onStorageChanged(): Promise<void> {
        for (const id of [...this.liveRanges.keys()])
            if (!this.storage.getThread(id))
                this.liveRanges.delete(id);
        return this.refresh();
    }

    /** Bring every editor thread in line with the stored threads. */
    reconcile(): void {
        const stored = this.storage.getAll();
        const ids = new Set(stored.map(s => s.id));
        for (const [id, entry] of this.entries) {
            if (!ids.has(id)) {
                entry.views.forEach(v => v.dispose());
                this.entries.delete(id);
                this.liveRanges.delete(id);
            }
        }

        for (const st of stored) {
            let entry = this.entries.get(st.id);
            if (!entry) {
                entry = { views: new Map() };
                this.entries.set(st.id, entry);
            }
            const primary = this.storage.resolveUri(st.filePath);
            const targets = new Map<string, { uri: vscode.Uri; range: { startLine: number; endLine: number } }>();
            targets.set(primary.toString(), { uri: primary, range: this.liveRanges.get(st.id) ?? st.range });
            for (const [key, alias] of this.aliases)
                if (samePath(alias.filePath, st.filePath))
                    targets.set(key, { uri: vscode.Uri.parse(key), range: st.range });

            for (const [key, view] of entry.views) {
                if (!targets.has(key)) {
                    view.dispose();
                    entry.views.delete(key);
                }
            }
            for (const [key, target] of targets) {
                const view = entry.views.get(key);
                if (view)
                    this.updateView(view, st, target.range, entry.shown);
                else
                    entry.views.set(key, this.createView(target.uri, st, target.range));
            }
            entry.shown = st;
        }
        this._onDidChangeThreads.fire();
    }

    private createView(uri: vscode.Uri, st: StoredThread, range: { startLine: number; endLine: number }): vscode.CommentThread {
        const view = this.controller.createCommentThread(uri, toRange(range), this.buildComments(st, []));
        view.collapsibleState = st.resolved
            ? vscode.CommentThreadCollapsibleState.Collapsed
            : vscode.CommentThreadCollapsibleState.Expanded;
        this.applyState(view, st);
        return view;
    }

    private updateView(view: vscode.CommentThread, st: StoredThread, range: { startLine: number; endLine: number }, before: StoredThread | undefined): void {
        const r = toRange(range);
        if (!view.range || !view.range.isEqual(r))
            view.range = r;

        const current = view.comments as ReviewComment[];
        const next = this.buildComments(st, current);
        if (next.length !== current.length || next.some((c, i) => c !== current[i]))
            view.comments = next;

        // Someone else (the agent) answered: open the thread so the reply is seen.
        if (before && st.comments.length > before.comments.length && lastAuthor(st) !== USER_AUTHOR && !st.resolved)
            view.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        if (before && before.resolved !== st.resolved)
            view.collapsibleState = st.resolved
                ? vscode.CommentThreadCollapsibleState.Collapsed
                : vscode.CommentThreadCollapsibleState.Expanded;
        this.applyState(view, st);
    }

    private applyState(view: vscode.CommentThread, st: StoredThread): void {
        const context = threadContext(st.id, st.resolved);
        if (view.contextValue !== context)
            view.contextValue = context;
        const state = st.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
        if (view.state !== state)
            view.state = state;
        const label = threadLabel(st);
        if (view.label !== label)
            view.label = label;
        view.canReply = true;
    }

    /** Reuse comment objects that did not change, and never replace one the user is editing. */
    private buildComments(st: StoredThread, current: ReviewComment[]): ReviewComment[] {
        return st.comments.map(sc => {
            const existing = current.find(c => c.id === sc.id);
            if (existing && (existing.editing || existing.sameAs(sc.id, sc.body, sc.author)))
                return existing;
            return new ReviewComment(sc.id, st.id, sc.body, sc.author, sc.timestamp);
        });
    }

    // ---- user actions -------------------------------------------------------------------------

    async handleCreateComment(reply: vscode.CommentReply): Promise<void> {
        const filePath = this.filePathFor(reply.thread.uri);
        if (!filePath) {
            reply.thread.dispose();
            vscode.window.showWarningMessage('Review comments can only be added to files inside the workspace folder (or to an unchanged copy of one in a diff).');
            return;
        }
        const id = generateId();
        const range = reply.thread.range ?? new vscode.Range(0, 0, 0, 0);
        const saved = await this.save(() => this.storage.mutate(threads => {
            threads.push({
                id,
                filePath,
                range: { startLine: range.start.line, endLine: range.end.line },
                resolved: false,
                comments: [{ id: generateId(), author: USER_AUTHOR, body: reply.text, timestamp: new Date().toISOString() }],
            });
        }), reply.text);
        if (!saved) {
            reply.thread.dispose();
            return;
        }
        // Adopt the thread VS Code created for the "+" so the widget stays where the user is.
        this.entries.set(id, { views: new Map([[reply.thread.uri.toString(), reply.thread]]) });
        reply.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        this.reconcile();
    }

    async handleReply(reply: vscode.CommentReply): Promise<void> {
        const id = threadIdOf(reply.thread);
        if (!id)
            return;
        await this.save(() => this.storage.mutate(threads => {
            const t = threads.find(x => x?.id === id);
            if (!t)
                throw new Error('This thread no longer exists in the comments file (it was deleted elsewhere).');
            t.comments.push({ id: generateId(), author: USER_AUTHOR, body: reply.text, timestamp: new Date().toISOString() });
            // A follow-up on a resolved thread reopens it, so the agent sees it as pending.
            t.resolved = false;
        }), reply.text);
        this.reconcile();
    }

    async handleSetResolved(thread: vscode.CommentThread, resolved: boolean): Promise<void> {
        const id = threadIdOf(thread);
        if (!id)
            return;
        await this.save(() => this.storage.mutate(threads => {
            const t = threads.find(x => x?.id === id);
            if (t)
                t.resolved = resolved;
        }));
        this.reconcile();
    }

    async handleDeleteThread(thread: vscode.CommentThread): Promise<void> {
        const id = threadIdOf(thread);
        if (!id || !(await this.confirmDelete(id)))
            return;
        await this.removeThread(id);
    }

    async handleDeleteComment(comment: vscode.Comment): Promise<void> {
        const rc = comment as ReviewComment;
        const stored = this.storage.getThread(rc.threadId);
        if (!stored)
            return;
        if (stored.comments.length <= 1) {
            if (await this.confirmDelete(rc.threadId))
                await this.removeThread(rc.threadId);
            return;
        }
        await this.save(() => this.storage.mutate(threads => {
            const t = threads.find(x => x?.id === rc.threadId);
            if (t)
                t.comments = t.comments.filter((c: any) => c?.id !== rc.id);
        }));
        this.reconcile();
    }

    handleEditComment(comment: vscode.Comment): void {
        const rc = comment as ReviewComment;
        rc.mode = vscode.CommentMode.Editing;
        rc.contextValue = 'editing';
        rc.body = rc.savedBody;
        this.redrawComment(rc);
    }

    async handleSaveComment(comment: vscode.Comment): Promise<void> {
        const rc = comment as ReviewComment;
        const text = bodyText(rc.body);
        if (text.trim() === '') {
            vscode.window.showWarningMessage('A comment cannot be empty. Use Delete Comment to remove it.');
            return;
        }
        const ok = await this.save(() => this.storage.mutate(threads => {
            const t = threads.find(x => x?.id === rc.threadId);
            const c = t?.comments.find((x: any) => x?.id === rc.id);
            if (!c)
                throw new Error('This comment no longer exists in the comments file.');
            c.body = text;
        }), text);
        if (!ok)
            return;
        rc.savedBody = text;
        rc.body = markdown(text);
        rc.mode = vscode.CommentMode.Preview;
        rc.contextValue = undefined;
        this.redrawComment(rc);
        this.reconcile();
    }

    handleCancelEdit(comment: vscode.Comment): void {
        const rc = comment as ReviewComment;
        rc.body = markdown(rc.savedBody);
        rc.mode = vscode.CommentMode.Preview;
        rc.contextValue = undefined;
        this.redrawComment(rc);
    }

    async handleResolveAll(): Promise<void> {
        const open = this.storage.getAll().filter(t => !t.resolved).length;
        if (open === 0) {
            vscode.window.showInformationMessage('There are no open review comments.');
            return;
        }
        const choice = await vscode.window.showWarningMessage(`Resolve all ${open} open review comment threads?`, { modal: true }, 'Resolve All');
        if (choice !== 'Resolve All')
            return;
        await this.save(() => this.storage.mutate(threads => {
            for (const t of threads)
                if (t && typeof t === 'object')
                    t.resolved = true;
        }));
        this.reconcile();
    }

    async goToThread(threadId: string): Promise<void> {
        const stored = this.storage.getThread(threadId);
        if (!stored)
            return;
        const uri = this.storage.resolveUri(stored.filePath);
        let doc: vscode.TextDocument;
        try {
            doc = await vscode.workspace.openTextDocument(uri);
        } catch {
            vscode.window.showWarningMessage(`${stored.filePath} no longer exists. The thread is kept in the comments file.`);
            return;
        }
        const editor = await vscode.window.showTextDocument(doc);
        const range = this.liveRanges.get(threadId) ?? stored.range;
        const pos = new vscode.Position(Math.min(range.startLine, doc.lineCount - 1), 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        const view = this.entries.get(threadId)?.views.get(uri.toString());
        if (view)
            view.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }

    getStoredThreads(): StoredThread[] {
        return this.storage.getAll().map(t => {
            const live = this.liveRanges.get(t.id);
            return live ? { ...t, range: live } : t;
        });
    }

    private async confirmDelete(id: string): Promise<boolean> {
        const n = this.storage.getThread(id)?.comments.length ?? 0;
        const choice = await vscode.window.showWarningMessage(
            n > 1 ? `Delete this thread and its ${n} comments?` : 'Delete this comment thread?',
            { modal: true }, 'Delete');
        return choice === 'Delete';
    }

    private async removeThread(id: string): Promise<void> {
        await this.save(() => this.storage.mutate(threads => {
            const i = threads.findIndex(x => x?.id === id);
            if (i !== -1)
                threads.splice(i, 1);
        }));
        this.reconcile();
    }

    /** Run a storage change; report failures to the user. Returns false when nothing was saved. */
    private async save(job: () => Promise<void>, unsavedText?: string): Promise<boolean> {
        try {
            await job();
            return true;
        } catch (e) {
            const msg = e instanceof StorageBrokenError || e instanceof Error ? e.message : String(e);
            const detail = unsavedText ? ` Your text: "${unsavedText.length > 200 ? unsavedText.slice(0, 200) + '…' : unsavedText}"` : '';
            vscode.window.showErrorMessage(`Review Comments: ${msg}${detail}`);
            return false;
        }
    }

    private redrawComment(rc: ReviewComment): void {
        for (const view of this.entries.get(rc.threadId)?.views.values() ?? [])
            if (view.comments.includes(rc))
                view.comments = [...view.comments];
    }

    // ---- keeping anchors on the code while the user edits -------------------------------------

    private onDocumentEdited(e: vscode.TextDocumentChangeEvent): void {
        if (e.contentChanges.length === 0 || e.document.uri.scheme !== 'file')
            return;
        const rel = this.filePathFor(e.document.uri);
        if (!rel)
            return;
        const threads = this.storage.getAll().filter(t => samePath(t.filePath, rel));
        if (threads.length === 0)
            return;

        const edits = e.contentChanges.map(c => ({
            startLine: c.range.start.line, startCharacter: c.range.start.character,
            endLine: c.range.end.line, endCharacter: c.range.end.character, text: c.text,
        }));
        let moved = false;
        for (const t of threads) {
            const cur = this.liveRanges.get(t.id) ?? t.range;
            const next = shiftRangeByEdits(cur, edits);
            if (next.startLine !== cur.startLine || next.endLine !== cur.endLine) {
                this.liveRanges.set(t.id, next);
                moved = true;
            }
        }
        if (moved)
            this.reconcile();
        this.scheduleCleanCheck(e.document, rel);
    }

    /**
     * Edits are applied at once, but VS Code marks the document dirty only after the change event.
     * If it is still clean shortly afterwards, the change was a reload from disk, a revert or an
     * undo back to the saved text: the comments file is the truth again (the agent re-anchors
     * threads itself when it edits code), so the unsaved moves are dropped.
     */
    private scheduleCleanCheck(doc: vscode.TextDocument, rel: string): void {
        const key = doc.uri.toString();
        clearTimeout(this.cleanChecks.get(key));
        this.cleanChecks.set(key, setTimeout(() => {
            this.cleanChecks.delete(key);
            if (doc.isDirty || doc.isClosed)
                return;
            let changed = false;
            for (const t of this.storage.getAll())
                if (samePath(t.filePath, rel))
                    changed = this.liveRanges.delete(t.id) || changed;
            if (changed)
                this.reconcile();
        }, 150));
    }

    private async onDocumentSaved(doc: vscode.TextDocument): Promise<void> {
        const rel = this.filePathFor(doc.uri);
        if (!rel)
            return;
        const moved = this.storage.getAll().filter(t => samePath(t.filePath, rel) && this.liveRanges.has(t.id));
        if (moved.length > 0) {
            const ranges = new Map(moved.map(t => [t.id, this.liveRanges.get(t.id)!]));
            const ok = await this.save(() => this.storage.mutate(threads => {
                for (const t of threads) {
                    const r = t && ranges.get(t.id);
                    if (r)
                        t.range = { ...(t.range ?? {}), startLine: r.startLine, endLine: r.endLine };
                }
            }));
            if (ok)
                for (const id of ranges.keys())
                    this.liveRanges.delete(id);
        }
        await this.refresh(rel);
    }

    private onDocumentClosed(doc: vscode.TextDocument): void {
        if (ALIAS_SCHEMES.has(doc.uri.scheme)) {
            if (this.aliases.delete(doc.uri.toString()))
                this.reconcile();
            return;
        }
        // Closed without saving: the unsaved moves are gone with the edits.
        const rel = this.filePathFor(doc.uri);
        if (!rel)
            return;
        let changed = false;
        for (const t of this.storage.getAll())
            if (samePath(t.filePath, rel))
                changed = this.liveRanges.delete(t.id) || changed;
        if (changed)
            this.reconcile();
    }

    private async onFilesRenamed(e: vscode.FileRenameEvent): Promise<void> {
        const pairs = e.files
            .map(f => ({ from: this.storage.relativePath(f.oldUri), to: this.storage.relativePath(f.newUri) }))
            .filter((p): p is { from: string; to: string } => !!p.from && !!p.to);
        const ci = process.platform === 'win32' || process.platform === 'darwin';
        const affected = this.storage.getAll().some(t => pairs.some(p => renamedPath(t.filePath, p.from, p.to, ci)));
        if (!affected)
            return;
        await this.save(() => this.storage.mutate(threads => {
            for (const t of threads) {
                if (!t || typeof t.filePath !== 'string')
                    continue;
                const current = t.filePath.replace(/\\/g, '/');
                for (const p of pairs) {
                    const next = renamedPath(current, p.from, p.to, ci);
                    if (next) {
                        t.filePath = next;
                        break;
                    }
                }
            }
        }));
        await this.refresh();
    }

    dispose(): void {
        this.cleanChecks.forEach(t => clearTimeout(t));
        this.disposables.forEach(d => d.dispose());
        for (const entry of this.entries.values())
            entry.views.forEach(v => v.dispose());
        this.entries.clear();
        this.controller.dispose();
        this._onDidChangeThreads.dispose();
    }
}

function toRange(r: { startLine: number; endLine: number }): vscode.Range {
    return new vscode.Range(r.startLine, 0, r.endLine, 0);
}

/** Stored paths compare case-insensitively where the file system does. */
function samePath(a: string, b: string): boolean {
    return process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function normaliseEol(s: string): string {
    return s.replace(/\r\n/g, '\n');
}
