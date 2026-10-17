/*
 * End-to-end UI tests: a real VS Code window driven with Playwright.
 *   npm run test:ui
 * Environment: RC_VSCODE_VERSION (default "stable"), RC_VSCODE_CACHE (default <tmp>/rc-vscode-test),
 * RC_KEEP=1 keeps the temp folder (screenshots, workspace) for inspection.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Driver, sleep } from './driver';
import { makeWorkspace } from '../workspace';

const root = Driver.tmpRoot();
const ws = makeWorkspace(path.join(root, 'ws'));
const jsonPath = path.join(ws, '.vscode', 'review-comments.json');
const readJson = (): any => JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const find = (s: string) => readJson().threads.find((t: any) => t.comments[0].body.includes(s));
function agentReply(match: string, body: string): void {
    const d = readJson();
    d.threads.find((t: any) => t.comments[0].body.includes(match)).comments.push({ id: 'cl' + Date.now().toString(36), author: 'Claude', body, timestamp: new Date().toISOString() });
    fs.writeFileSync(jsonPath, JSON.stringify(d, null, 2) + '\n');
}
async function waitFor(cond: () => boolean, what: string, ms = 5000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        try { if (cond()) return; } catch { /* mid-write */ }
        await sleep(100);
    }
    assert.fail('timed out waiting for ' + what);
}

let d: Driver;
const tests: [string, () => Promise<void>][] = [];
const it = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

// ---- base flows ---------------------------------------------------------------------------

it('add a comment from the Command Palette', async () => {
    await d.openFile('src/app.py');
    await d.gotoLine(10);
    await d.addComment('U1 please rename f8');
    const t = find('U1');
    assert.deepEqual(t.range, { startLine: 9, endLine: 9 });
    assert.equal(t.filePath, 'src/app.py');
    const w = d.widget('U1 please');
    assert.ok(await w.count(), 'widget shown');
    assert.equal((await d.threads()).find(x => x.comments[0]?.body.includes('U1'))?.label, 'Open');
});

it('add a comment on a multi-line selection', async () => {
    await d.gotoLine(20);
    await d.page.keyboard.press('Shift+ArrowDown');
    await d.page.keyboard.press('Shift+ArrowDown');
    await d.addComment('U2 multi line');
    assert.deepEqual(find('U2').range, { startLine: 19, endLine: 21 });
});

it('add a comment with the mouse via the gutter "+"', async () => {
    await d.gotoLine(30);
    await d.escape();
    const line = d.page.locator('.editor-instance .view-line', { hasText: 'def f28(x)' }).first();
    await line.hover();
    const glyph = d.page.locator('.comment-range-glyph.line-hover').first();
    await glyph.waitFor({ state: 'visible' });
    await glyph.click();
    await sleep(500);
    await d.type('U3 from the gutter');
    await d.page.keyboard.press('Control+Enter');
    await sleep(1200);
    assert.equal(find('U3').range.startLine, 29);
});

it('reply in the editor', async () => {
    await d.gotoLine(10);
    await d.reply(d.widget('U1 please'), 'U4 user reply');
    assert.deepEqual(find('U1').comments.map((c: any) => c.body), ['U1 please rename f8', 'U4 user reply']);
});

it('agent reply appears live, rendered as markdown, label says who replied', async () => {
    agentReply('U1', 'U5 **done**, renamed `f8`');
    assert.ok(await d.waitForComment(c => c.author === 'Claude' && c.body.includes('U5')), 'Claude reply shown');
    const body = (await d.threads()).flatMap(t => t.comments).find(c => c.body.includes('U5'))!.body;
    assert.ok(!body.includes('**') && !body.includes('`'), body);
    assert.equal((await d.threads()).find(x => x.comments[0]?.body.includes('U1'))?.label, 'Open · Claude replied');
});

it('user reply after the agent keeps the agent reply', async () => {
    await d.gotoLine(10);
    await d.reply(d.widget('U1 please'), 'U6 follow up');
    assert.equal(find('U1').comments.map((c: any) => c.author).join(','), 'User,User,Claude,User');
});

it('edit a comment', async () => {
    await d.gotoLine(10);
    const first = d.widget('U1 please').locator('.review-comment').first();
    assert.ok(await d.action(first, 'Edit'));
    await d.page.keyboard.press('Control+A');
    await d.type('U1 please rename f8 (edited)');
    await d.page.keyboard.press('Control+Enter');
    await sleep(1000);
    assert.equal(find('U1').comments[0].body, 'U1 please rename f8 (edited)');
});

it('resolve, then Reopen is offered and works', async () => {
    await d.gotoLine(10);
    assert.ok(await d.action(d.widget('U1 please'), 'Resolve Thread'));
    assert.equal(find('U1').resolved, true);
    await d.command('Comments: Expand All Comments');
    await d.gotoLine(10);
    const w = d.widget('U1 please');
    assert.equal(await w.locator('[aria-label="Resolve Thread"]').count(), 0, 'Resolve hidden');
    assert.ok(await d.action(w, 'Reopen Thread'), 'Reopen offered');
    assert.equal(find('U1').resolved, false);
});

it('a reply on a resolved thread reopens it', async () => {
    await d.gotoLine(20);
    assert.ok(await d.action(d.widget('U2 multi'), 'Resolve Thread'));
    await d.command('Comments: Expand All Comments');
    await d.gotoLine(20);
    await d.reply(d.widget('U2 multi'), 'U7 one more thing');
    assert.equal(find('U2').resolved, false);
});

it('delete one comment', async () => {
    await d.gotoLine(10);
    const c = d.widget('U1 please').locator('.review-comment', { hasText: 'U6 follow up' }).first();
    assert.ok(await d.action(c, 'Delete Comment'));
    assert.ok(!find('U1').comments.some((x: any) => x.body === 'U6 follow up'));
});

it('a reply being typed survives the agent rewriting the file', async () => {
    await d.gotoLine(20);
    const w = d.widget('U2 multi');
    await d.openReplyBox(w);
    await d.type('U8 half-typed draft');
    agentReply('U2', 'U8 agent wrote meanwhile');
    assert.ok(await d.waitForComment(c => c.body.includes('U8 agent wrote')), 'agent reply shown');
    const draft = await d.page.evaluate(() => [...(globalThis as any).document.querySelectorAll('.review-widget .comment-form')]
        .some((f: any) => f.innerText.replace(/ /g, ' ').includes('U8 half-typed draft')));
    assert.ok(draft, 'draft still in the reply box');
    await d.page.keyboard.press('Control+Enter');
    await sleep(1200);
    assert.equal(find('U2').comments.at(-1).body, 'U8 half-typed draft');
});

it('a collapsed thread stays collapsed when another thread gets a reply', async () => {
    await d.gotoLine(30);
    assert.ok(await d.action(d.widget('U3 from the gutter'), 'Collapse'));
    agentReply('U1', 'U9 another agent reply');
    assert.ok(await d.waitForComment(c => c.body.includes('U9')));
    await d.gotoLine(30);
    const visible = await d.widget('U3 from the gutter').locator('.review-comment').first().isVisible().catch(() => false);
    assert.equal(visible, false);
});

it('deleting a thread asks first; Cancel keeps it, Delete removes it', async () => {
    await d.command('Comments: Expand All Comments');
    await d.gotoLine(30);
    assert.ok(await d.action(d.widget('U3 from the gutter'), 'Delete Thread'));
    const msg = await d.dialog('Cancel');
    assert.ok(msg && /Delete this/.test(msg), 'confirmation shown: ' + msg);
    assert.ok(find('U3'), 'kept after Cancel');
    assert.ok(await d.action(d.widget('U3 from the gutter'), 'Delete Thread'));
    await d.dialog('Delete');
    assert.equal(find('U3'), undefined);
});

it('sidebar lists threads with status and navigates to them', async () => {
    await d.command('Review Comments: Focus on Comments View');
    const view = d.page.locator('.pane', { hasText: 'Comments' }).filter({ has: d.page.locator('.monaco-list-row') }).first();
    const rows = d.page.locator('[id="workbench.view.extension.review-comments-container"] .monaco-list-row, .pane-body .monaco-list-row', { hasText: 'U2 multi' });
    await rows.first().waitFor();
    const text = await rows.first().innerText();
    assert.match(text, /L20-22/);
    assert.match(text, /Claude replied|repl/);
    await rows.first().click();
    await sleep(800);
    const status = await d.page.locator('.statusbar-item[id*="selection"], #status\\.editor\\.selection').first().innerText().catch(() => '');
    assert.match(status, /Ln 20/, status);
    void view;
});

// ---- edge cases ---------------------------------------------------------------------------

it('broken comments file: threads stay, a warning is shown, nothing is overwritten, recovers', async () => {
    const good = fs.readFileSync(jsonPath, 'utf8');
    try {
    fs.writeFileSync(jsonPath, '{ "threads": [ { "id": ');
    await sleep(2500);
    const notes = await d.notifications();
    assert.ok(notes.some(n => /not valid JSON/.test(n)), 'warning: ' + notes.join(' | '));
    assert.ok((await d.threads()).some(t => t.comments.some(c => c.body.includes('U1 please'))), 'threads still shown');
    await d.openFile('src/app.py');
    await d.gotoLine(10);
    await d.reply(d.widget('U1 please'), 'U10 must not be saved');
    assert.equal(fs.readFileSync(jsonPath, 'utf8'), '{ "threads": [ { "id": ');
    const errors = await d.notifications();
    assert.ok(errors.some(n => /not saved/.test(n) && /U10 must not be saved/.test(n)), 'error with the unsaved text: ' + errors.join(' | '));
    await d.clearNotifications();
    } finally {
        fs.writeFileSync(jsonPath, good);
    }
    await sleep(1000);
    await d.gotoLine(10);
    await d.reply(d.widget('U1 please'), 'U11 saved after fix');
    assert.equal(find('U1').comments.at(-1).body, 'U11 saved after fix');
});

it('untitled documents cannot get comments', async () => {
    await d.command('File: New Untitled Text File');
    await d.type('scratch text');
    const offered = await d.commandAvailable('Comments: Add Comment on Current Selection');
    await d.command('View: Revert and Close Editor');
    assert.equal(offered, false, 'Add Comment must not be offered on an untitled file');
    await d.openFile('src/app.py');
    await d.gotoLine(3);
    assert.equal(await d.commandAvailable('Comments: Add Comment on Current Selection'), true, 'but it is on a workspace file');
});

it('empty files and paths with spaces and non-ASCII characters', async () => {
    await d.openFile('empty.txt');
    await d.addCommentWithMouse(1, 'U13 empty file');
    assert.deepEqual(find('U13').range, { startLine: 0, endLine: 0 });
    await d.openFile('ünïcode');
    await d.gotoLine(2);
    await d.addComment('U14 unicode path');
    assert.equal(find('U14').filePath, 'src/ünïcode файл.py');
});

it('typing above a thread moves it; saving writes the new line', async () => {
    await d.openFile('src/util.py');
    await d.gotoLine(4);
    await d.addComment('U15 anchor');
    await d.gotoLine(1);
    await d.page.keyboard.press('Home');
    await d.type('import os\nimport sys\n');
    await sleep(500);
    assert.equal(find('U15').range.startLine, 3, 'unchanged until saved');
    await d.page.keyboard.press('Control+S');
    await waitFor(() => find('U15').range.startLine === 5, 'anchor written as line 6');
});

it('window reload restores every thread', async () => {
    const count = readJson().threads.length;
    await d.command('File: Save All');
    await d.command('Developer: Reload Window');
    await d.dismissSavePrompts(6000);
    await d.page.waitForSelector('.monaco-workbench');
    await d.focusWorkbench();
    await d.openFile('src/app.py');
    await d.gotoLine(10);
    assert.ok(await d.waitForComment(c => c.body.includes('U1 please'), 10000), 'thread back after reload');
    assert.equal(readJson().threads.length, count);
});

// ---- diff and compare views ----------------------------------------------------------------

it('Compare with Branch: the working-tree side takes comments and edits', async () => {
    await d.command('Review Comments: Compare with Branch…');
    await d.pick('main');
    await d.page.locator('.multiDiffEntry', { hasText: 'app.py' }).first().waitFor({ timeout: 15000 });
    await d.shot('compare-with-branch');
    const appDiff = d.page.locator('.multiDiffEntry', { hasText: 'app.py' }).first();
    await d.addCommentWithMouse(6, 'U16 comment in compare view', appDiff.locator('.editor.modified'));
    const t = find('U16');
    assert.equal(t?.filePath, 'src/app.py');
    assert.equal(t?.range.startLine, 5);
    agentReply('U16', 'U17 agent answered in compare view');
    assert.ok(await d.waitForComment(c => c.body.includes('U17')), 'agent reply visible in the diff');
    await d.focusDiffSide('modified', 8, 'app.py');
    await d.type('# edited in compare view ');
    await sleep(300);
    const dirty = await d.page.locator('.tab.dirty, .multiDiffEntry .dirty, .editor-actions .codicon-close-dirty').count();
    await d.page.keyboard.press('Control+S');
    await sleep(800);
    assert.ok(fs.readFileSync(path.join(ws, 'src', 'app.py'), 'utf8').includes('# edited in compare view'), 'edit saved to the file');
    void dirty;
});

it('VS Code snapshot compare (git: on both sides): matching right side shows and takes comments, left side does not', async () => {
    // Commit the edit so HEAD equals the working tree again, as after a normal commit.
    require('child_process').execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'wip', '--allow-empty'], { cwd: ws });
    fs.writeFileSync(path.join(ws, '.rc-test.json'), JSON.stringify({ path: 'src/app.py', leftRef: 'main', rightRef: 'HEAD' }));
    await d.command('View: Close All Editors');
    await d.command('RC Test: Open Snapshot Diff');
    await d.page.locator('.monaco-diff-editor').first().waitFor({ timeout: 15000 });
    await sleep(1500);
    assert.ok(await d.waitForComment(c => c.body.includes('U16 comment in compare view')), 'existing thread shown on the snapshot');
    const diff = d.page.locator('.editor-instance .monaco-diff-editor').first();
    await d.command('Comments: Collapse All Comments');
    await d.focusDiffSide('modified', 12);
    await d.addCommentWithMouse(12, 'U18 on snapshot right side', diff.locator('.editor.modified'));
    assert.equal(find('U18')?.filePath, 'src/app.py');
    assert.equal(find('U18')?.range.startLine, 11);
    await d.escape(2);
    assert.equal(await d.canCommentWithMouse(3, diff.locator('.editor.original')), false, 'left (old) side must not take comments');
    await d.shot('snapshot-compare');
});

it('Open Changes with uncommitted edits: file side takes comments, stale snapshot does not', async () => {
    const p = path.join(ws, 'src', 'util.py');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8') + 'f = 6\n');
    fs.writeFileSync(path.join(ws, '.rc-test.json'), JSON.stringify({ path: 'src/util.py', leftRef: 'HEAD' }));
    await d.escape(2);
    await d.command('View: Close All Editors');
    await d.command('RC Test: Open Working Tree Diff');
    await d.page.locator('.monaco-diff-editor').first().waitFor({ timeout: 15000 });
    await sleep(1000);
    const wt = d.page.locator('.editor-instance .monaco-diff-editor').first();
    await d.addCommentWithMouse(2, 'U20 on working tree side', wt.locator('.editor.modified'));
    assert.equal(find('U20')?.filePath, 'src/util.py');
    await d.escape(2);
    assert.equal(await d.canCommentWithMouse(2, wt.locator('.editor.original')), false, 'stale snapshot must not take comments');
});

async function main(): Promise<void> {
    const version = process.env.RC_VSCODE_VERSION ?? 'stable';
    const cache = process.env.RC_VSCODE_CACHE ?? path.join(os.tmpdir(), 'rc-vscode-test');
    const extRoot = path.resolve(__dirname, '../../..');
    d = await Driver.launch({ ws, extension: extRoot, helper: path.join(extRoot, 'test-fixtures', 'ui-helper'), root, version, cache });
    console.log(`VS Code ${version}, workspace ${ws}`);
    let failed = 0;
    for (const [name, fn] of tests) {
        try {
            await Promise.race([fn(), sleep(120000).then(() => { throw new Error('test timed out after 120 s'); })]);
            console.log(`  ✔ ${name}`);
        } catch (e) {
            failed++;
            const shot = await d.shot('FAIL ' + name);
            console.log(`  ✘ ${name}\n      ${(e as Error).message.split('\n').join('\n      ')}\n      screenshot: ${shot}`);
            await d.escape(3);
        }
    }
    await d.close();
    console.log(`\n${tests.length - failed}/${tests.length} UI tests passed`);
    if (!process.env.RC_KEEP && failed === 0)
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    else
        console.log(`kept ${root}`);
    if (failed)
        process.exit(1);
}

main().catch(async e => {
    console.error(e);
    await d?.close();
    process.exit(1);
});
