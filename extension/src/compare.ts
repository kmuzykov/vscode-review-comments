import * as vscode from 'vscode';

/*
 * "Compare with Branch…": shows every file that differs between a chosen branch (from its merge
 * base with HEAD) and the working tree, in VS Code's multi-file diff editor. Unlike the built-in
 * branch compare, the right-hand side is the real file, so it can be edited and commented on.
 */

// The few parts of the built-in Git extension's API (vscode.git, version 1) that are used here.
interface GitChange {
    readonly uri: vscode.Uri;
    readonly originalUri: vscode.Uri;
    readonly renameUri: vscode.Uri | undefined;
    readonly status: number;
}
interface GitRef {
    readonly type: number;
    readonly name?: string;
    readonly commit?: string;
    readonly remote?: string;
}
interface GitRepository {
    readonly rootUri: vscode.Uri;
    readonly state: {
        readonly HEAD: GitRef | undefined;
        readonly refs: GitRef[];
        readonly workingTreeChanges: GitChange[];
        readonly untrackedChanges?: GitChange[];
    };
    getRefs?(query?: object): Promise<GitRef[]>;
    getMergeBase(ref1: string, ref2: string): Promise<string | undefined>;
    diffWith(ref: string): Promise<GitChange[]>;
}
interface GitAPI {
    readonly repositories: GitRepository[];
    getRepository(uri: vscode.Uri): GitRepository | null;
    toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}

// Values of the Git extension's Status enum that matter here.
const ADDED = new Set([1 /* INDEX_ADDED */, 7 /* UNTRACKED */, 9 /* INTENT_TO_ADD */]);
const DELETED = new Set([2 /* INDEX_DELETED */, 6 /* DELETED */]);
const REF_HEAD = 0;
const REF_REMOTE_HEAD = 1;

async function gitApi(): Promise<GitAPI | undefined> {
    const ext = vscode.extensions.getExtension<{ getAPI(version: 1): GitAPI }>('vscode.git');
    if (!ext)
        return undefined;
    const exports = ext.isActive ? ext.exports : await ext.activate();
    return exports?.getAPI(1);
}

export async function compareWithBranch(folder: vscode.WorkspaceFolder, preselected?: string): Promise<void> {
    const git = await gitApi();
    if (!git) {
        vscode.window.showErrorMessage('Compare with Branch needs the built-in Git extension, which is disabled.');
        return;
    }
    const repo = git.getRepository(folder.uri) ?? git.repositories[0];
    if (!repo) {
        vscode.window.showErrorMessage('The workspace folder is not a Git repository (or Git has not finished loading).');
        return;
    }

    const refs = (repo.getRefs ? await repo.getRefs({}) : repo.state.refs)
        .filter(r => (r.type === REF_HEAD || r.type === REF_REMOTE_HEAD) && r.name && r.name !== repo.state.HEAD?.name && !r.name.endsWith('/HEAD'));
    let target = preselected;
    if (!target) {
        const rank = (name: string) => ['main', 'master', 'origin/main', 'origin/master', 'develop'].indexOf(name);
        const items = refs
            .map(r => ({ label: r.name!, description: r.type === REF_REMOTE_HEAD ? 'remote branch' : 'branch', rank: rank(r.name!) }))
            .sort((a, b) => (a.rank === -1 ? 99 : a.rank) - (b.rank === -1 ? 99 : b.rank) || a.label.localeCompare(b.label));
        const pick = await vscode.window.showQuickPick(items, {
            title: 'Compare the working tree with…',
            placeHolder: `Changes since the branch point are shown; current branch: ${repo.state.HEAD?.name ?? 'detached HEAD'}`,
        });
        if (!pick)
            return;
        target = pick.label;
    }

    const base = (await repo.getMergeBase(target, 'HEAD')) ?? target;
    const changes = await repo.diffWith(base);
    const untracked = [
        ...(repo.state.untrackedChanges ?? []),
        ...repo.state.workingTreeChanges.filter(c => c.status === 7),
    ];
    const seen = new Set(changes.map(c => c.uri.toString()));
    for (const u of untracked)
        if (!seen.has(u.uri.toString())) {
            changes.push(u);
            seen.add(u.uri.toString());
        }

    if (changes.length === 0) {
        vscode.window.showInformationMessage(`No differences between ${target} and the working tree.`);
        return;
    }

    const resources: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = changes
        .sort((a, b) => a.uri.path.localeCompare(b.uri.path))
        .map(c => {
            const current = c.renameUri ?? c.uri;
            if (ADDED.has(c.status))
                return [current, undefined, current];
            if (DELETED.has(c.status))
                return [c.uri, git.toGitUri(c.originalUri, base), undefined];
            return [current, git.toGitUri(c.originalUri, base), current];
        });
    await vscode.commands.executeCommand('vscode.changes', `${target} ↔ Working Tree`, resources);
}
