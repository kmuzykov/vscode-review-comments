import * as vscode from 'vscode';
import * as path from 'path';
import { ReviewCommentController } from './commentController';
import { StoredThread, USER_AUTHOR, lastAuthor } from './model';

type TreeItem = FileItem | ThreadItem;

/** Tree node representing a file that has comments. */
class FileItem extends vscode.TreeItem {
    constructor(
        public readonly filePath: string,
        uri: vscode.Uri,
        threadCount: number,
        unresolvedCount: number
    ) {
        super(path.posix.basename(filePath), vscode.TreeItemCollapsibleState.Expanded);
        const dir = path.posix.dirname(filePath);
        this.description = dir === '.' ? '' : dir;
        this.tooltip = `${filePath} (${unresolvedCount} of ${threadCount} open)`;
        this.iconPath = vscode.ThemeIcon.File;
        this.resourceUri = uri;
    }
}

/** Tree node representing a single comment thread. */
class ThreadItem extends vscode.TreeItem {
    constructor(
        public readonly threadId: string,
        public readonly stored: StoredThread
    ) {
        const firstComment = stored.comments[0];
        const lineLabel = stored.range.startLine === stored.range.endLine
            ? `L${stored.range.startLine + 1}`
            : `L${stored.range.startLine + 1}-${stored.range.endLine + 1}`;

        super(truncate(firstComment?.body ?? '', 80), vscode.TreeItemCollapsibleState.None);

        const parts = [lineLabel];
        if (stored.comments.length > 1)
            parts.push(`${stored.comments.length - 1} ${stored.comments.length === 2 ? 'reply' : 'replies'}`);
        const last = lastAuthor(stored);
        if (!stored.resolved && last !== USER_AUTHOR)
            parts.push(`${last} replied`);
        this.description = parts.join(' · ');
        this.tooltip = new vscode.MarkdownString(stored.comments.map(c => `**${c.author}**: ${c.body}`).join('\n\n'));
        this.iconPath = stored.resolved
            ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'))
            : last !== USER_AUTHOR
                ? new vscode.ThemeIcon('comment-unresolved', new vscode.ThemeColor('editorWarning.foreground'))
                : new vscode.ThemeIcon('comment', new vscode.ThemeColor('editorInfo.foreground'));

        this.command = {
            command: 'review-comments.goToComment',
            title: 'Go to Comment',
            arguments: [threadId]
        };
    }
}

/**
 * Provides a tree view of all review comment threads, grouped by file.
 */
export class CommentsTreeProvider implements vscode.TreeDataProvider<TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private commentController: ReviewCommentController, private resolveUri: (filePath: string) => vscode.Uri) {
        commentController.onDidChangeThreads(() => this.refresh());
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: TreeItem): vscode.ProviderResult<TreeItem[]> {
        const threads = this.commentController.getStoredThreads();
        if (!element) {
            const byFile = new Map<string, StoredThread[]>();
            for (const t of threads) {
                if (!byFile.has(t.filePath))
                    byFile.set(t.filePath, []);
                byFile.get(t.filePath)!.push(t);
            }
            return [...byFile.entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([filePath, list]) => new FileItem(filePath, this.resolveUri(filePath), list.length, list.filter(t => !t.resolved).length));
        }

        if (element instanceof FileItem) {
            return threads
                .filter(t => t.filePath === element.filePath)
                .sort((a, b) => a.range.startLine - b.range.startLine)
                .map(t => new ThreadItem(t.id, t));
        }

        return [];
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}

function truncate(text: string, max: number): string {
    const singleLine = text.replace(/\s*\n\s*/g, ' ').trim();
    if (singleLine.length <= max)
        return singleLine || '(empty)';
    return singleLine.substring(0, max - 1) + '…';
}
