import * as vscode from 'vscode';
import * as path from 'path';
import { ReviewCommentController } from './commentController';
import { StoredThread } from './storage';

type TreeItem = FileItem | ThreadItem;

/** Tree node representing a file that has comments. */
class FileItem extends vscode.TreeItem {
    constructor(
        public readonly filePath: string,
        public readonly threadCount: number,
        public readonly unresolvedCount: number
    ) {
        super(path.basename(filePath), vscode.TreeItemCollapsibleState.Expanded);
        this.description = path.dirname(filePath);
        this.tooltip = `${filePath} (${unresolvedCount} unresolved)`;
        this.iconPath = vscode.ThemeIcon.File;
        this.resourceUri = vscode.Uri.file(filePath);
    }
}

/** Tree node representing a single comment thread. */
class ThreadItem extends vscode.TreeItem {
    constructor(
        public readonly threadId: string,
        public readonly stored: StoredThread
    ) {
        const firstComment = stored.comments[0];
        const preview = firstComment ? truncate(firstComment.body, 80) : '(empty)';
        const lineLabel = stored.range.startLine === stored.range.endLine
            ? `L${stored.range.startLine + 1}`
            : `L${stored.range.startLine + 1}-${stored.range.endLine + 1}`;

        super(preview, vscode.TreeItemCollapsibleState.None);

        this.description = lineLabel;
        this.tooltip = firstComment?.body ?? '';
        this.iconPath = stored.resolved
            ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'))
            : new vscode.ThemeIcon('comment', new vscode.ThemeColor('editorInfo.foreground'));

        if (stored.comments.length > 1) {
            this.description += ` (${stored.comments.length} replies)`;
        }

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

    constructor(private commentController: ReviewCommentController) {
        commentController.onDidChangeThreads(() => this.refresh());
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: TreeItem): vscode.ProviderResult<TreeItem[]> {
        if (!element) {
            // Root level: group by file
            const entries = this.commentController.getThreadEntries();
            const byFile = new Map<string, Array<{ threadId: string; stored: StoredThread }>>();

            for (const entry of entries) {
                const file = entry.stored.filePath;
                if (!byFile.has(file))
                    byFile.set(file, []);
                byFile.get(file)!.push(entry);
            }

            if (byFile.size === 0)
                return [];

            return Array.from(byFile.entries()).map(([filePath, threads]) => {
                const unresolvedCount = threads.filter(t => !t.stored.resolved).length;
                return new FileItem(filePath, threads.length, unresolvedCount);
            });
        }

        if (element instanceof FileItem) {
            const entries = this.commentController.getThreadEntries();
            return entries
                .filter(e => e.stored.filePath === element.filePath)
                .sort((a, b) => a.stored.range.startLine - b.stored.range.startLine)
                .map(e => new ThreadItem(e.threadId, e.stored));
        }

        return [];
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}

function truncate(text: string, max: number): string {
    const singleLine = text.replace(/\n/g, ' ').trim();
    if (singleLine.length <= max)
        return singleLine;
    return singleLine.substring(0, max - 3) + '...';
}
