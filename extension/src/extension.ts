import * as vscode from 'vscode';
import { CommentStorage } from './storage';
import { ReviewCommentController } from './commentController';
import { CommentsTreeProvider } from './treeView';
import { compareWithBranch } from './compare';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return;
    }

    const storage = new CommentStorage(workspaceFolder);
    await storage.reload();

    const commentController = new ReviewCommentController(storage);
    await commentController.refresh();

    // The agent (or anything else) rewrote the file: bring the editor in line.
    const watcher = storage.startWatching();
    storage.onDidChange(() => commentController.onStorageChanged());
    storage.onDidChangeHealth(() => reportHealth(storage));
    reportHealth(storage);

    const treeProvider = new CommentsTreeProvider(commentController, p => storage.resolveUri(p));
    const treeView = vscode.window.createTreeView('review-comments.threads', {
        treeDataProvider: treeProvider,
        showCollapseAll: true
    });
    const updateBadge = () => {
        const open = storage.getAll().filter(t => !t.resolved).length;
        treeView.badge = open > 0 ? { value: open, tooltip: `${open} open review comment thread${open === 1 ? '' : 's'}` } : undefined;
    };
    commentController.onDidChangeThreads(updateBadge);
    updateBadge();

    const commands = [
        vscode.commands.registerCommand('review-comments.createComment', (reply: vscode.CommentReply) =>
            commentController.handleCreateComment(reply)),
        vscode.commands.registerCommand('review-comments.reply', (reply: vscode.CommentReply) =>
            commentController.handleReply(reply)),
        vscode.commands.registerCommand('review-comments.resolve', (thread: vscode.CommentThread) =>
            commentController.handleSetResolved(thread, true)),
        vscode.commands.registerCommand('review-comments.unresolve', (thread: vscode.CommentThread) =>
            commentController.handleSetResolved(thread, false)),
        vscode.commands.registerCommand('review-comments.deleteThread', (thread: vscode.CommentThread) =>
            commentController.handleDeleteThread(thread)),
        vscode.commands.registerCommand('review-comments.deleteComment', (comment: vscode.Comment) =>
            commentController.handleDeleteComment(comment)),
        vscode.commands.registerCommand('review-comments.editComment', (comment: vscode.Comment) =>
            commentController.handleEditComment(comment)),
        vscode.commands.registerCommand('review-comments.saveComment', (comment: vscode.Comment) =>
            commentController.handleSaveComment(comment)),
        vscode.commands.registerCommand('review-comments.cancelEdit', (comment: vscode.Comment) =>
            commentController.handleCancelEdit(comment)),
        vscode.commands.registerCommand('review-comments.resolveAll', () =>
            commentController.handleResolveAll()),
        vscode.commands.registerCommand('review-comments.goToComment', (threadId: string) =>
            commentController.goToThread(threadId)),
        vscode.commands.registerCommand('review-comments.compareWithBranch', (branch?: string) =>
            compareWithBranch(workspaceFolder, typeof branch === 'string' ? branch : undefined)),
        vscode.commands.registerCommand('review-comments.openCommentsFile', () =>
            vscode.window.showTextDocument(storage.uri)),
    ];

    context.subscriptions.push(
        storage,
        commentController,
        treeProvider,
        treeView,
        watcher,
        ...commands
    );
}

let shownProblem: string | undefined;
let brokenTimer: ReturnType<typeof setTimeout> | undefined;

/** Tell the user, once per distinct problem, when the comments file cannot be fully used. */
function reportHealth(storage: CommentStorage): void {
    if (brokenTimer)
        clearTimeout(brokenTimer);
    if (storage.broken !== undefined) {
        // Give a half-written file a moment to become valid before complaining.
        brokenTimer = setTimeout(() => {
            const problem = `broken:${storage.broken}`;
            if (storage.broken === undefined || problem === shownProblem)
                return;
            shownProblem = problem;
            vscode.window.showWarningMessage(
                `Review Comments: .vscode/review-comments.json is not valid JSON (${storage.broken}). The editor keeps showing the last good version and will not save until the file is fixed.`,
                'Open File'
            ).then(choice => { if (choice) vscode.commands.executeCommand('review-comments.openCommentsFile'); });
        }, 1500);
        return;
    }
    if (storage.invalidThreads.length > 0) {
        const problem = `invalid:${storage.invalidThreads.join('|')}`;
        if (problem === shownProblem)
            return;
        shownProblem = problem;
        vscode.window.showWarningMessage(
            `Review Comments: ${storage.invalidThreads.length} thread(s) in .vscode/review-comments.json cannot be shown and are left untouched: ${storage.invalidThreads.join('; ')}`,
            'Open File'
        ).then(choice => { if (choice) vscode.commands.executeCommand('review-comments.openCommentsFile'); });
        return;
    }
    shownProblem = undefined;
}

export function deactivate(): void {
    // Cleanup handled by disposables
}
