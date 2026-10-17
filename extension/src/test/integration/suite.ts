/*
 * Runs inside the extension host. Exercises the extension through its commands and the real
 * VS Code file, editor and rename APIs, while another "agent" writes the comments file directly.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as assert from 'assert';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let ws = '';
let jsonPath = '';

const readJson = (): any => JSON.parse(fs.readFileSync(jsonPath, 'utf8').replace(/^﻿/, ''));
const writeJson = (data: unknown, opts: { bom?: boolean; atomic?: boolean } = {}) => {
    const text = (opts.bom ? '﻿' : '') + JSON.stringify(data, null, 2) + '\n';
    if (opts.atomic) {
        fs.writeFileSync(jsonPath + '.tmp', text);
        fs.renameSync(jsonPath + '.tmp', jsonPath);
    } else {
        fs.writeFileSync(jsonPath, text);
    }
};
const fileUri = (rel: string) => vscode.Uri.file(path.join(ws, rel));
const thread = (id: string, filePath: string, startLine: number, author = 'User', body = 'please fix') => ({
    id, filePath, range: { startLine, endLine: startLine }, resolved: false,
    comments: [{ id: id + '-c0', author, body, timestamp: new Date().toISOString() }],
});

/** Stand-ins for the thread objects VS Code passes to the comment commands. */
function fakeThread(uri: vscode.Uri, line: number, contextValue?: string): any {
    return { uri, range: new vscode.Range(line, 0, line, 0), comments: [], contextValue, dispose() { /* nothing */ } };
}
async function userAdds(rel: string | vscode.Uri, line: number, text: string): Promise<string | undefined> {
    const t = fakeThread(typeof rel === 'string' ? fileUri(rel) : rel, line);
    await vscode.commands.executeCommand('review-comments.createComment', { thread: t, text });
    return t.contextValue?.replace(/^(un)?resolved:/, '');
}
async function userReplies(id: string, text: string): Promise<void> {
    await vscode.commands.executeCommand('review-comments.reply', { thread: fakeThread(fileUri('src/app.py'), 0, 'unresolved:' + id), text });
}
async function waitFor(cond: () => boolean, what: string, ms = 4000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        try { if (cond()) return; } catch { /* file mid-write */ }
        await sleep(50);
    }
    assert.fail('timed out waiting for ' + what);
}
const authors = (id: string) => readJson().threads.find((t: any) => t.id === id)?.comments.map((c: any) => c.author).join(',');

/** Wait until the extension has loaded what is on disk (its own write after a reply proves it). */
async function settle(): Promise<void> {
    await sleep(400);
}

const tests: [string, () => Promise<void>][] = [];
const it = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

it('adding a comment creates the file with the thread', async () => {
    const id = await userAdds('src/app.py', 9, 'rename f8');
    assert.ok(id);
    const t = readJson().threads.find((x: any) => x.id === id);
    assert.deepEqual(t.range, { startLine: 9, endLine: 9 });
    assert.equal(t.filePath, 'src/app.py');
    assert.equal(t.comments[0].author, 'User');
});

it('agent reply (in-place write) then user reply: both kept', async () => {
    const id = (await userAdds('src/app.py', 2, 'q1'))!;
    const d = readJson();
    d.threads.find((t: any) => t.id === id).comments.push({ id: 'a1', author: 'Claude', body: 'done', timestamp: '' });
    writeJson(d);
    await settle();
    await userReplies(id, 'thanks');
    assert.equal(authors(id), 'User,Claude,User');
});

it('agent reply (atomic rename write) then user reply: both kept', async () => {
    const id = (await userAdds('src/app.py', 3, 'q2'))!;
    const d = readJson();
    d.threads.find((t: any) => t.id === id).comments.push({ id: 'a2', author: 'Claude', body: 'done', timestamp: '' });
    writeJson(d, { atomic: true });
    await settle();
    await userReplies(id, 'thanks');
    assert.equal(authors(id), 'User,Claude,User');
});

it('race: user replies in the same tick the agent writes, before any watcher event', async () => {
    const id = (await userAdds('src/app.py', 4, 'q3'))!;
    const d = readJson();
    d.threads.find((t: any) => t.id === id).comments.push({ id: 'a3', author: 'Claude', body: 'done', timestamp: '' });
    writeJson(d);
    await userReplies(id, 'instant reply');
    assert.equal(authors(id), 'User,Claude,User');
});

it('20 replies fired at once are all saved, in order', async () => {
    const id = (await userAdds('src/app.py', 5, 'burst'))!;
    await Promise.all(Array.from({ length: 20 }, (_, i) => userReplies(id, 'r' + i)));
    const bodies = readJson().threads.find((t: any) => t.id === id).comments.map((c: any) => c.body);
    assert.deepEqual(bodies, ['burst', ...Array.from({ length: 20 }, (_, i) => 'r' + i)]);
});

it('broken JSON: user action is refused and the file is not overwritten; recovers when fixed', async () => {
    const id = (await userAdds('src/app.py', 6, 'before break'))!;
    const good = readJson();
    fs.writeFileSync(jsonPath, '{ "threads": [ { "id": "half-written"');
    await settle();
    await userReplies(id, 'should not be saved');
    assert.equal(fs.readFileSync(jsonPath, 'utf8'), '{ "threads": [ { "id": "half-written"');
    writeJson(good);
    await settle();
    await userReplies(id, 'saved after fix');
    assert.equal(readJson().threads.find((t: any) => t.id === id).comments.at(-1).body, 'saved after fix');
    assert.equal(readJson().threads.length, good.threads.length);
});

it('file written with a UTF-8 BOM (Windows PowerShell) is read and kept working', async () => {
    const d = readJson();
    d.threads.push(thread('bom1', 'src/util.py', 1, 'Claude', 'from powershell'));
    writeJson(d, { bom: true });
    await settle();
    await userReplies('bom1', 'got it');
    assert.equal(authors('bom1'), 'Claude,User');
});

it('unknown fields and threads the extension cannot show survive a user action', async () => {
    const d = readJson();
    d.schemaNote = 'keep me';
    d.threads.push({ id: 'broken-thread', filePath: 'src/util.py', comments: [] });
    d.threads.push({ ...thread('extra1', 'src/util.py', 2), labels: ['perf'] });
    writeJson(d);
    await settle();
    await userReplies('extra1', 'reply');
    const after = readJson();
    assert.equal(after.schemaNote, 'keep me');
    assert.ok(after.threads.some((t: any) => t.id === 'broken-thread'));
    assert.deepEqual(after.threads.find((t: any) => t.id === 'extra1').labels, ['perf']);
    after.threads = after.threads.filter((t: any) => t.id !== 'broken-thread');
    delete after.schemaNote;
    writeJson(after);
    await settle();
});

it('comments are refused on untitled documents and files outside the workspace', async () => {
    const before = fs.readFileSync(jsonPath, 'utf8');
    await userAdds(vscode.Uri.parse('untitled:Untitled-9'), 0, 'nope');
    await userAdds(vscode.Uri.file(path.join(path.dirname(ws), 'outside.txt')), 0, 'nope');
    await userAdds(vscode.Uri.file(jsonPath), 0, 'not on the comments file itself');
    assert.equal(fs.readFileSync(jsonPath, 'utf8'), before);
});

it('editing above a thread and saving moves its anchor; the file follows', async () => {
    const id = (await userAdds('src/util.py', 3, 'anchor me'))!;
    const doc = await vscode.workspace.openTextDocument(fileUri('src/util.py'));
    const editor = await vscode.window.showTextDocument(doc);
    await editor.edit(e => e.insert(new vscode.Position(0, 0), 'import os\nimport sys\n'));
    await sleep(200);
    assert.equal(readJson().threads.find((t: any) => t.id === id).range.startLine, 3, 'not written before save');
    await doc.save();
    await waitFor(() => readJson().threads.find((t: any) => t.id === id).range.startLine === 5, 'anchor moved to line 5');
});

it('unsaved edits that are reverted leave the anchor where it was', async () => {
    const id = (await userAdds('src/util.py', 6, 'stay'))!;
    const doc = await vscode.workspace.openTextDocument(fileUri('src/util.py'));
    const editor = await vscode.window.showTextDocument(doc);
    await editor.edit(e => e.insert(new vscode.Position(0, 0), 'x\ny\nz\n'));
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await sleep(300);
    await doc.save();
    await sleep(300);
    assert.equal(readJson().threads.find((t: any) => t.id === id).range.startLine, 6);
});

it('agent edits code on disk and re-anchors: no double shift when the open editor reloads', async () => {
    const id = (await userAdds('src/util.py', 4, 'agent moves me'))!;
    const doc = await vscode.workspace.openTextDocument(fileUri('src/util.py'));
    await vscode.window.showTextDocument(doc);
    const p = path.join(ws, 'src', 'util.py');
    fs.writeFileSync(p, '# header\n' + fs.readFileSync(p, 'utf8'));
    const d = readJson();
    d.threads.find((t: any) => t.id === id).range = { startLine: 5, endLine: 5 };
    writeJson(d);
    await waitFor(() => doc.getText().startsWith('# header'), 'editor reloaded the file');
    await sleep(400);
    await userReplies(id, 'ok');
    assert.equal(readJson().threads.find((t: any) => t.id === id).range.startLine, 5);
});

it('renaming a file and a folder updates thread paths', async () => {
    const id = (await userAdds('docs/notes with space.md', 2, 'rename follows'))!;
    let edit = new vscode.WorkspaceEdit();
    edit.renameFile(fileUri('docs/notes with space.md'), fileUri('docs/renamed notes.md'));
    assert.ok(await vscode.workspace.applyEdit(edit));
    await waitFor(() => readJson().threads.find((t: any) => t.id === id).filePath === 'docs/renamed notes.md', 'file rename');
    edit = new vscode.WorkspaceEdit();
    edit.renameFile(fileUri('docs'), fileUri('documentation'));
    assert.ok(await vscode.workspace.applyEdit(edit));
    await waitFor(() => readJson().threads.find((t: any) => t.id === id).filePath === 'documentation/renamed notes.md', 'folder rename');
});

it('non-ASCII paths round-trip', async () => {
    const id = (await userAdds('src/ünïcode файл.py', 1, 'unicode'))!;
    assert.equal(readJson().threads.find((t: any) => t.id === id).filePath, 'src/ünïcode файл.py');
});

it('deleting the comments file clears threads; the next comment recreates it', async () => {
    fs.unlinkSync(jsonPath);
    await settle();
    const id = await userAdds('src/app.py', 1, 'fresh start');
    const d = readJson();
    assert.equal(d.threads.length, 1);
    assert.equal(d.threads[0].id, id);
});

it('agent writes a backslash path: user can still reply and the path is kept as written', async () => {
    const d = readJson();
    d.threads.push(thread('bs1', 'src\\app.py', 7, 'Claude', 'windows path'));
    writeJson(d);
    await settle();
    await userReplies('bs1', 'fine');
    assert.equal(authors('bs1'), 'Claude,User');
});

export async function run(): Promise<void> {
    ws = vscode.workspace.workspaceFolders![0].uri.fsPath;
    jsonPath = path.join(ws, '.vscode', 'review-comments.json');
    const ext = vscode.extensions.getExtension('kmuzykov.vscode-review-comments')!;
    await ext.activate();
    let failed = 0;
    for (const [name, fn] of tests) {
        try {
            await fn();
            console.log(`  ✔ ${name}`);
        } catch (e) {
            failed++;
            console.log(`  ✘ ${name}\n      ${(e as Error).message.split('\n').join('\n      ')}`);
        }
    }
    console.log(`\n${tests.length - failed}/${tests.length} integration tests passed`);
    if (failed)
        throw new Error(`${failed} integration test(s) failed`);
}
