import * as vscode from 'vscode';
import { CommentStorage } from './storage';
import { ReviewCommentController } from './commentController';
import { CommentsTreeProvider } from './treeView';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return;
    }

    // Initialize storage and comment controller
    const storage = new CommentStorage(workspaceFolder);
    await storage.load();

    const commentController = new ReviewCommentController(storage);
    await commentController.restoreThreads();

    // Start watching for external changes (e.g. Claude editing the JSON)
    const watcher = storage.startWatching();
    storage.onDidChange(() => commentController.rebuildFromStorage());

    // Set up the sidebar tree view
    const treeProvider = new CommentsTreeProvider(commentController);
    const treeView = vscode.window.createTreeView('review-comments.threads', {
        treeDataProvider: treeProvider,
        showCollapseAll: true
    });

    // Register commands
    const commands = [
        vscode.commands.registerCommand('review-comments.createComment', (reply: vscode.CommentReply) => {
            commentController.handleCreateComment(reply);
        }),
        vscode.commands.registerCommand('review-comments.reply', (reply: vscode.CommentReply) => {
            commentController.handleReply(reply);
        }),
        vscode.commands.registerCommand('review-comments.resolve', (thread: vscode.CommentThread) => {
            commentController.handleResolve(thread);
        }),
        vscode.commands.registerCommand('review-comments.unresolve', (thread: vscode.CommentThread) => {
            commentController.handleUnresolve(thread);
        }),
        vscode.commands.registerCommand('review-comments.deleteThread', (thread: vscode.CommentThread) => {
            commentController.handleDeleteThread(thread);
        }),
        vscode.commands.registerCommand('review-comments.deleteComment', (comment: vscode.Comment) => {
            commentController.handleDeleteComment(comment);
        }),
        vscode.commands.registerCommand('review-comments.editComment', (comment: vscode.Comment) => {
            commentController.handleEditComment(comment);
        }),
        vscode.commands.registerCommand('review-comments.saveComment', (comment: vscode.Comment) => {
            commentController.handleSaveComment(comment);
        }),
        vscode.commands.registerCommand('review-comments.cancelEdit', (comment: vscode.Comment) => {
            commentController.handleCancelEdit(comment);
        }),
        vscode.commands.registerCommand('review-comments.resolveAll', () => {
            commentController.handleResolveAll();
        }),
        vscode.commands.registerCommand('review-comments.goToComment', (threadId: string) => {
            commentController.goToThread(threadId);
        })
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

export function deactivate(): void {
    // Cleanup handled by disposables
}
