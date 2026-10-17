import * as vscode from 'vscode';
import * as path from 'path';
import { RawData, StoredThread, parseCommentsFile, serialise } from './model';

export { StoredThread, StoredComment, generateId } from './model';

const STORAGE_FILE = '.vscode/review-comments.json';

/** Raised when a change cannot be saved because the file on disk is not valid. */
export class StorageBrokenError extends Error {}

/**
 * Owns `.vscode/review-comments.json`.
 *
 * - Every change is applied on top of a fresh read of the file and written in one go, and changes
 *   are queued, so a reply the agent wrote a moment ago is never overwritten by a stale copy.
 * - Our own writes are recognised by content, not by counting watcher events.
 * - If the file cannot be parsed (half-written, hand-edited, BOM from another tool is fine), the
 *   last good state stays on screen and nothing is written until the file is valid again.
 */
export class CommentStorage {
    private raw: RawData = { threads: [] };
    private threads: StoredThread[] = [];
    /** Text of the file as last read or written by us; undefined when the file does not exist. */
    private lastText: string | undefined;
    private brokenReason: string | undefined;
    private problems: string[] = [];
    private queue: Promise<unknown> = Promise.resolve();
    private readonly storageUri: vscode.Uri;
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    /** Fires when the threads changed because of an external edit (e.g. the agent replied). */
    readonly onDidChange = this._onDidChange.event;
    private readonly _onDidChangeHealth = new vscode.EventEmitter<void>();
    /** Fires when the file becomes unreadable or readable again, or its problems change. */
    readonly onDidChangeHealth = this._onDidChangeHealth.event;

    constructor(readonly workspaceFolder: vscode.WorkspaceFolder) {
        this.storageUri = vscode.Uri.joinPath(workspaceFolder.uri, STORAGE_FILE);
    }

    get uri(): vscode.Uri {
        return this.storageUri;
    }

    /** Why the file on disk cannot be used right now, or undefined when it is fine. */
    get broken(): string | undefined {
        return this.brokenReason;
    }

    /** Threads present in the file that cannot be shown (missing fields, duplicate ids). */
    get invalidThreads(): readonly string[] {
        return this.problems;
    }

    /** Re-read the file. Returns true when the threads changed. */
    async reload(): Promise<boolean> {
        return this.enqueue(() => this.reloadNow());
    }

    private async reloadNow(): Promise<boolean> {
        let text: string | undefined;
        try {
            text = new TextDecoder().decode(await vscode.workspace.fs.readFile(this.storageUri));
        } catch {
            text = undefined;
        }
        if (text === this.lastText && this.brokenReason === undefined)
            return false;

        if (text === undefined) {
            const had = this.threads.length > 0;
            this.setState({ threads: [] }, [], [], undefined, undefined);
            return had;
        }

        const parsed = parseCommentsFile(text);
        if (!parsed.ok) {
            if (this.brokenReason !== parsed.error) {
                this.brokenReason = parsed.error;
                this._onDidChangeHealth.fire();
            }
            return false;
        }
        const changed = JSON.stringify(parsed.threads) !== JSON.stringify(this.threads);
        this.setState(parsed.raw, parsed.threads, parsed.problems, text, undefined);
        return changed;
    }

    private setState(raw: RawData, threads: StoredThread[], problems: string[], text: string | undefined, broken: string | undefined): void {
        const healthChanged = this.brokenReason !== broken || this.problems.join('\n') !== problems.join('\n');
        this.raw = raw;
        this.threads = threads;
        this.problems = problems;
        this.lastText = text;
        this.brokenReason = broken;
        if (healthChanged)
            this._onDidChangeHealth.fire();
    }

    /**
     * Apply a change to the latest content of the file and write it. `fn` receives the raw thread
     * objects (unknown fields included) and may mutate them. Throws StorageBrokenError, without
     * writing, when the file on disk is not valid.
     */
    async mutate(fn: (rawThreads: any[]) => void): Promise<void> {
        return this.enqueue(async () => {
            const external = await this.reloadNow();
            if (this.brokenReason !== undefined) {
                throw new StorageBrokenError(
                    `${STORAGE_FILE} is not valid JSON (${this.brokenReason}). Your change was not saved; fix or delete the file and try again.`);
            }
            fn(this.raw.threads);
            const text = serialise(this.raw);
            const parsed = parseCommentsFile(text);
            if (!parsed.ok)
                throw new Error(`internal error: produced invalid JSON (${parsed.error})`);
            const dir = vscode.Uri.joinPath(this.workspaceFolder.uri, '.vscode');
            await vscode.workspace.fs.createDirectory(dir);
            await vscode.workspace.fs.writeFile(this.storageUri, new TextEncoder().encode(text));
            this.setState(parsed.raw, parsed.threads, parsed.problems, text, undefined);
            if (external)
                this._onDidChange.fire();
        });
    }

    /** Watch the file for changes made by anything else, and re-check when the window regains focus. */
    startWatching(): vscode.Disposable {
        const pattern = new vscode.RelativePattern(this.workspaceFolder, STORAGE_FILE);
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const schedule = (delay = 75) => {
            if (timer)
                clearTimeout(timer);
            timer = setTimeout(async () => {
                timer = undefined;
                if (await this.reload())
                    this._onDidChange.fire();
                // A half-written file usually becomes valid a moment later.
                if (this.brokenReason !== undefined)
                    setTimeout(() => schedule(0), 500);
            }, delay);
        };
        const focus = vscode.window.onDidChangeWindowState(s => { if (s.focused) schedule(0); });
        return vscode.Disposable.from(
            watcher,
            focus,
            watcher.onDidChange(() => schedule()),
            watcher.onDidCreate(() => schedule()),
            watcher.onDidDelete(() => schedule()),
            { dispose: () => timer && clearTimeout(timer) },
        );
    }

    getAll(): StoredThread[] {
        return this.threads;
    }

    getThread(id: string): StoredThread | undefined {
        return this.threads.find(t => t.id === id);
    }

    /** Absolute URI for a stored path (workspace-relative, or absolute as written by hand). */
    resolveUri(filePath: string): vscode.Uri {
        if (path.isAbsolute(filePath) || /^[a-zA-Z]:\//.test(filePath))
            return vscode.Uri.file(filePath);
        return vscode.Uri.joinPath(this.workspaceFolder.uri, filePath);
    }

    /** Workspace-relative path with forward slashes, or undefined for files outside the folder. */
    relativePath(uri: vscode.Uri): string | undefined {
        const rel = path.relative(this.workspaceFolder.uri.fsPath, uri.fsPath);
        if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel))
            return undefined;
        return rel.replace(/\\/g, '/');
    }

    private enqueue<T>(job: () => Promise<T>): Promise<T> {
        const next = this.queue.then(job, job);
        this.queue = next.catch(() => undefined);
        return next;
    }

    dispose(): void {
        this._onDidChange.dispose();
        this._onDidChangeHealth.dispose();
    }
}
