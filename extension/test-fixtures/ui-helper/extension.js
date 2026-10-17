// Test-only helper. Reads <workspace>/.rc-test.json for its arguments, because commands run from
// the Command Palette cannot take any.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

async function git() {
    const ext = vscode.extensions.getExtension('vscode.git');
    const exports = ext.isActive ? ext.exports : await ext.activate();
    return exports.getAPI(1);
}

function args() {
    const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
    return { ws, ...JSON.parse(fs.readFileSync(path.join(ws, '.rc-test.json'), 'utf8')) };
}

exports.activate = context => {
    // Same shape as Source Control Graph "Compare with…": both sides are git: snapshots.
    context.subscriptions.push(vscode.commands.registerCommand('rcTest.openSnapshotDiff', async () => {
        const a = args();
        const api = await git();
        const file = vscode.Uri.file(path.join(a.ws, a.path));
        await vscode.commands.executeCommand('vscode.diff', api.toGitUri(file, a.leftRef), api.toGitUri(file, a.rightRef), `${a.path} (${a.leftRef} ↔ ${a.rightRef})`);
    }));
    // Same shape as Source Control "Open Changes": committed snapshot on the left, the file on the right.
    context.subscriptions.push(vscode.commands.registerCommand('rcTest.openWorkingTreeDiff', async () => {
        const a = args();
        const api = await git();
        const file = vscode.Uri.file(path.join(a.ws, a.path));
        await vscode.commands.executeCommand('vscode.diff', api.toGitUri(file, a.leftRef), file, `${a.path} (Working Tree)`);
    }));
};
