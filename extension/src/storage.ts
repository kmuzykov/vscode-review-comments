import * as vscode from 'vscode';
import * as path from 'path';

/** A single comment within a thread. */
export interface StoredComment {
    id: string;
    author: string;
    body: string;
    timestamp: string;
}

/** A comment thread attached to a file range. */
export interface StoredThread {
    id: string;
    filePath: string;
    range: { startLine: number; endLine: number };
    resolved: boolean;
    comments: StoredComment[];
}

/** Root structure of the JSON file. */
export interface StoredData {
    threads: StoredThread[];
}

const STORAGE_FILE = '.vscode/review-comments.json';

/**
 * Manages reading, writing, and watching the review comments JSON file.
 * All paths stored in the JSON are workspace-relative.
 */
export class CommentStorage {
    private data: StoredData = { threads: [] };
    private storageUri: vscode.Uri;
    private watcher: vscode.FileSystemWatcher | undefined;
    private _onDidChange = new vscode.EventEmitter<void>();
    /** Fires when the storage file changes externally (e.g. Claude editing it). */
    readonly onDidChange = this._onDidChange.event;
    private suppressNextWatch = false;

    constructor(private workspaceFolder: vscode.WorkspaceFolder) {
        this.storageUri = vscode.Uri.joinPath(workspaceFolder.uri, STORAGE_FILE);
    }

    /** Load existing comments from disk. */
    async load(): Promise<StoredData> {
        try {
            const content = await vscode.workspace.fs.readFile(this.storageUri);
            this.data = JSON.parse(new TextDecoder().decode(content));
        } catch {
            this.data = { threads: [] };
        }
        return this.data;
    }

    /** Persist current state to disk. */
    async save(): Promise<void> {
        this.suppressNextWatch = true;
        const dir = vscode.Uri.joinPath(this.workspaceFolder.uri, '.vscode');
        try {
            await vscode.workspace.fs.stat(dir);
        } catch {
            await vscode.workspace.fs.createDirectory(dir);
        }
        const content = new TextEncoder().encode(JSON.stringify(this.data, null, 2) + '\n');
        await vscode.workspace.fs.writeFile(this.storageUri, content);
    }

    /** Start watching the JSON file for external changes. */
    startWatching(): vscode.Disposable {
        const pattern = new vscode.RelativePattern(this.workspaceFolder, STORAGE_FILE);
        this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

        this.watcher.onDidChange(async () => {
            if (this.suppressNextWatch) {
                this.suppressNextWatch = false;
                return;
            }
            await this.load();
            this._onDidChange.fire();
        });

        this.watcher.onDidCreate(async () => {
            if (this.suppressNextWatch) {
                this.suppressNextWatch = false;
                return;
            }
            await this.load();
            this._onDidChange.fire();
        });

        this.watcher.onDidDelete(() => {
            this.data = { threads: [] };
            this._onDidChange.fire();
        });

        return this.watcher;
    }

    getAll(): StoredThread[] {
        return this.data.threads;
    }

    getUnresolved(): StoredThread[] {
        return this.data.threads.filter(t => !t.resolved);
    }

    getThread(id: string): StoredThread | undefined {
        return this.data.threads.find(t => t.id === id);
    }

    async addThread(thread: StoredThread): Promise<void> {
        this.data.threads.push(thread);
        await this.save();
    }

    async updateThread(id: string, update: Partial<StoredThread>): Promise<void> {
        const thread = this.data.threads.find(t => t.id === id);
        if (thread) {
            Object.assign(thread, update);
            await this.save();
        }
    }

    async removeThread(id: string): Promise<void> {
        this.data.threads = this.data.threads.filter(t => t.id !== id);
        await this.save();
    }

    async resolveAll(): Promise<void> {
        for (const thread of this.data.threads) {
            thread.resolved = true;
        }
        await this.save();
    }

    /** Convert a workspace-relative path to an absolute URI. */
    resolveUri(filePath: string): vscode.Uri {
        return vscode.Uri.joinPath(this.workspaceFolder.uri, filePath);
    }

    /** Convert an absolute URI to a workspace-relative path. */
    relativePath(uri: vscode.Uri): string {
        return path.relative(this.workspaceFolder.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
    }

    dispose(): void {
        this.watcher?.dispose();
        this._onDidChange.dispose();
    }
}

/** Generate a short random ID. */
export function generateId(): string {
    return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}
