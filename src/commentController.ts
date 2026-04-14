import * as vscode from 'vscode';
import { CommentStorage, StoredThread, StoredComment, generateId } from './storage';

const CONTROLLER_ID = 'review-comments';

/**
 * A comment object that tracks its storage ID and saved body for edit/cancel.
 */
class ReviewComment implements vscode.Comment {
    readonly id: string;
    savedBody: string;
    body: string | vscode.MarkdownString;
    mode: vscode.CommentMode;
    author: vscode.CommentAuthorInformation;
    timestamp?: Date;
    contextValue?: string;

    constructor(id: string, body: string, mode: vscode.CommentMode, author: string, timestamp?: string) {
        this.id = id;
        this.body = body;
        this.savedBody = body;
        this.mode = mode;
        this.author = { name: author };
        this.timestamp = timestamp ? new Date(timestamp) : new Date();
        this.contextValue = mode === vscode.CommentMode.Editing ? 'editing' : undefined;
    }
}

/**
 * Manages the VS Code CommentController and maps between storage and VS Code threads.
 */
export class ReviewCommentController {
    private controller: vscode.CommentController;
    /** Map from storage thread ID to VS Code CommentThread. */
    private threads = new Map<string, vscode.CommentThread>();
    private _onDidChangeThreads = new vscode.EventEmitter<void>();
    readonly onDidChangeThreads = this._onDidChangeThreads.event;

    constructor(private storage: CommentStorage) {
        this.controller = vscode.comments.createCommentController(CONTROLLER_ID, 'Review Comments');

        // Show the "+" gutter icon on every line of every file
        this.controller.commentingRangeProvider = {
            provideCommentingRanges: (document: vscode.TextDocument) => {
                return [new vscode.Range(0, 0, document.lineCount - 1, 0)];
            }
        };
    }

    /** Restore all threads from storage (called on activation). */
    async restoreThreads(): Promise<void> {
        const stored = this.storage.getAll();
        for (const st of stored) {
            this.createVscodeThread(st);
        }
    }

    /** Rebuild all VS Code threads from current storage state. Called when file changes externally. */
    async rebuildFromStorage(): Promise<void> {
        // Dispose existing threads
        for (const thread of this.threads.values()) {
            thread.dispose();
        }
        this.threads.clear();

        // Re-create from storage
        const stored = this.storage.getAll();
        for (const st of stored) {
            this.createVscodeThread(st);
        }
        this._onDidChangeThreads.fire();
    }

    /** Handle a new comment creation from the gutter "+" icon. */
    async handleCreateComment(reply: vscode.CommentReply): Promise<void> {
        const threadId = generateId();
        const commentId = generateId();
        const filePath = this.storage.relativePath(reply.thread.uri);
        const range = reply.thread.range;

        const storedThread: StoredThread = {
            id: threadId,
            filePath,
            range: {
                startLine: range?.start.line ?? 0,
                endLine: range?.end.line ?? 0
            },
            resolved: false,
            comments: [{
                id: commentId,
                author: 'User',
                body: reply.text,
                timestamp: new Date().toISOString()
            }]
        };

        await this.storage.addThread(storedThread);

        // The reply.thread from CommentReply is a temporary thread created by VS Code
        // when user clicks the "+" gutter. We need to populate it and track it.
        const comment = new ReviewComment(commentId, reply.text, vscode.CommentMode.Preview, 'User');
        reply.thread.comments = [comment];
        reply.thread.contextValue = threadId;
        reply.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        reply.thread.canReply = true;

        this.threads.set(threadId, reply.thread);
        this._onDidChangeThreads.fire();
    }

    /** Handle a reply to an existing thread. */
    async handleReply(reply: vscode.CommentReply): Promise<void> {
        const threadId = reply.thread.contextValue;
        if (!threadId)
            return;

        const commentId = generateId();
        const storedComment: StoredComment = {
            id: commentId,
            author: 'User',
            body: reply.text,
            timestamp: new Date().toISOString()
        };

        const storedThread = this.storage.getThread(threadId);
        if (!storedThread)
            return;

        storedThread.comments.push(storedComment);
        await this.storage.updateThread(threadId, { comments: storedThread.comments });

        const comment = new ReviewComment(commentId, reply.text, vscode.CommentMode.Preview, 'User');
        reply.thread.comments = [...reply.thread.comments, comment];
        this._onDidChangeThreads.fire();
    }

    /** Toggle resolved state on a thread. */
    async handleResolve(thread: vscode.CommentThread): Promise<void> {
        const threadId = thread.contextValue;
        if (!threadId)
            return;

        await this.storage.updateThread(threadId, { resolved: true });
        thread.state = vscode.CommentThreadState.Resolved;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
        thread.contextValue = threadId; // Keep ID but add resolved marker
        (thread as any)._resolved = true;
        this._onDidChangeThreads.fire();
    }

    /** Reopen a resolved thread. */
    async handleUnresolve(thread: vscode.CommentThread): Promise<void> {
        const threadId = thread.contextValue;
        if (!threadId)
            return;

        await this.storage.updateThread(threadId, { resolved: false });
        thread.state = vscode.CommentThreadState.Unresolved;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        (thread as any)._resolved = false;
        this._onDidChangeThreads.fire();
    }

    /** Delete an entire thread. */
    async handleDeleteThread(thread: vscode.CommentThread): Promise<void> {
        const threadId = thread.contextValue;
        if (!threadId)
            return;

        await this.storage.removeThread(threadId);
        thread.dispose();
        this.threads.delete(threadId);
        this._onDidChangeThreads.fire();
    }

    /** Delete a single comment. If it's the last one, delete the thread. */
    async handleDeleteComment(comment: vscode.Comment): Promise<void> {
        const rc = comment as ReviewComment;
        // Find the thread containing this comment
        for (const [threadId, thread] of this.threads) {
            const idx = thread.comments.findIndex(c => (c as ReviewComment).id === rc.id);
            if (idx === -1)
                continue;

            const storedThread = this.storage.getThread(threadId);
            if (!storedThread)
                return;

            if (thread.comments.length <= 1) {
                // Last comment — delete thread
                await this.handleDeleteThread(thread);
            } else {
                storedThread.comments = storedThread.comments.filter(c => c.id !== rc.id);
                await this.storage.updateThread(threadId, { comments: storedThread.comments });
                thread.comments = thread.comments.filter(c => (c as ReviewComment).id !== rc.id);
                this._onDidChangeThreads.fire();
            }
            return;
        }
    }

    /** Switch a comment to edit mode. */
    handleEditComment(comment: vscode.Comment): void {
        const rc = comment as ReviewComment;
        rc.mode = vscode.CommentMode.Editing;
        rc.contextValue = 'editing';
        this.refreshThreadContaining(rc);
    }

    /** Save an edited comment. */
    async handleSaveComment(comment: vscode.Comment): Promise<void> {
        const rc = comment as ReviewComment;
        rc.savedBody = typeof rc.body === 'string' ? rc.body : rc.body.value;
        rc.mode = vscode.CommentMode.Preview;
        rc.contextValue = undefined;
        this.refreshThreadContaining(rc);

        // Persist to storage
        for (const [threadId] of this.threads) {
            const storedThread = this.storage.getThread(threadId);
            if (!storedThread)
                continue;
            const sc = storedThread.comments.find(c => c.id === rc.id);
            if (sc) {
                sc.body = rc.savedBody;
                await this.storage.updateThread(threadId, { comments: storedThread.comments });
                break;
            }
        }
        this._onDidChangeThreads.fire();
    }

    /** Cancel editing and restore the saved body. */
    handleCancelEdit(comment: vscode.Comment): void {
        const rc = comment as ReviewComment;
        rc.body = rc.savedBody;
        rc.mode = vscode.CommentMode.Preview;
        rc.contextValue = undefined;
        this.refreshThreadContaining(rc);
    }

    /** Resolve all threads. */
    async handleResolveAll(): Promise<void> {
        await this.storage.resolveAll();
        for (const thread of this.threads.values()) {
            thread.state = vscode.CommentThreadState.Resolved;
            thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
        }
        this._onDidChangeThreads.fire();
    }

    /** Get all thread entries for the TreeView. */
    getThreadEntries(): Array<{ threadId: string; stored: StoredThread; thread: vscode.CommentThread }> {
        const entries: Array<{ threadId: string; stored: StoredThread; thread: vscode.CommentThread }> = [];
        for (const [threadId, thread] of this.threads) {
            const stored = this.storage.getThread(threadId);
            if (stored) {
                entries.push({ threadId, stored, thread });
            }
        }
        return entries;
    }

    /** Navigate to a thread's location in the editor. */
    async goToThread(threadId: string): Promise<void> {
        const stored = this.storage.getThread(threadId);
        if (!stored)
            return;

        const uri = this.storage.resolveUri(stored.filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);
        const range = new vscode.Range(stored.range.startLine, 0, stored.range.endLine, 0);
        editor.selection = new vscode.Selection(range.start, range.start);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

        // Expand the thread
        const thread = this.threads.get(threadId);
        if (thread) {
            thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        }
    }

    /** Create a VS Code CommentThread from stored data. */
    private createVscodeThread(stored: StoredThread): void {
        const uri = this.storage.resolveUri(stored.filePath);
        const range = new vscode.Range(stored.range.startLine, 0, stored.range.endLine, 0);

        const comments = stored.comments.map(sc =>
            new ReviewComment(sc.id, sc.body, vscode.CommentMode.Preview, sc.author, sc.timestamp)
        );

        const thread = this.controller.createCommentThread(uri, range, comments);
        thread.contextValue = stored.id;
        thread.canReply = true;
        thread.collapsibleState = stored.resolved
            ? vscode.CommentThreadCollapsibleState.Collapsed
            : vscode.CommentThreadCollapsibleState.Expanded;
        thread.state = stored.resolved
            ? vscode.CommentThreadState.Resolved
            : vscode.CommentThreadState.Unresolved;

        this.threads.set(stored.id, thread);
    }

    /** Force VS Code to re-render a thread by reassigning its comments array. */
    private refreshThreadContaining(rc: ReviewComment): void {
        for (const thread of this.threads.values()) {
            if (thread.comments.some(c => (c as ReviewComment).id === rc.id)) {
                thread.comments = [...thread.comments];
                return;
            }
        }
    }

    dispose(): void {
        this.controller.dispose();
        this._onDidChangeThreads.dispose();
        for (const thread of this.threads.values()) {
            thread.dispose();
        }
        this.threads.clear();
    }
}
