/*
 * Drives a real VS Code window with Playwright (Electron/CDP): keyboard, mouse and DOM reads,
 * the same way a person uses the editor.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { _electron, ElectronApplication, Locator, Page } from 'playwright-core';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface Thread {
    label: string;
    comments: { author: string; body: string }[];
}

export class Driver {
    private constructor(readonly app: ElectronApplication, readonly page: Page, readonly ws: string, readonly shots: string) { }

    static async launch(opts: { ws: string; extension: string; helper: string; root: string; version: string; cache: string }): Promise<Driver> {
        const exe = await downloadAndUnzipVSCode({ version: opts.version, cachePath: opts.cache });
        const ud = path.join(opts.root, 'ud');
        fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
        fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({
            'workbench.startupEditor': 'none',
            'security.workspace.trust.enabled': false,
            'update.mode': 'none',
            'extensions.autoUpdate': false,
            'extensions.autoCheckUpdates': false,
            'workbench.tips.enabled': false,
            'editor.minimap.enabled': false,
            'telemetry.telemetryLevel': 'off',
            'chat.disableAIFeatures': true,
            'workbench.secondarySideBar.defaultVisibility': 'hidden',
            'git.openRepositoryInParentFolders': 'always',
            'window.restoreWindows': 'none',
            'files.hotExit': 'off',
            'window.dialogStyle': 'custom',
            'diffEditor.renderSideBySide': true,
            'diffEditor.hideUnchangedRegions.enabled': false,
            'multiDiffEditor.experimental.enabled': true,
        }, null, 2));
        const app = await _electron.launch({
            executablePath: exe,
            args: [
                opts.ws,
                `--extensionDevelopmentPath=${opts.extension}`,
                `--extensionDevelopmentPath=${opts.helper}`,
                `--user-data-dir=${ud}`,
                `--extensions-dir=${path.join(opts.root, 'ext')}`,
                '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window',
            ],
            timeout: 120000,
        });
        const page = await app.firstWindow();
        await page.waitForSelector('.monaco-workbench', { timeout: 120000 });
        page.setDefaultTimeout(8000);
        const shots = path.join(opts.root, 'screenshots');
        fs.mkdirSync(shots, { recursive: true });
        const d = new Driver(app, page, opts.ws, shots);
        await d.waitForExtension();
        return d;
    }

    /** Wait until the Review Comments view is registered (the extension has activated). */
    private async waitForExtension(): Promise<void> {
        for (let i = 0; i < 60; i++) {
            if (await this.page.locator('.activitybar [aria-label^="Review Comments"]').count())
                return;
            await sleep(500);
        }
    }

    /** Close the window; if a dialog or a hang gets in the way, kill the test instance. */
    async close(): Promise<void> {
        const proc = this.app.process();
        await Promise.race([this.app.close().catch(() => undefined), sleep(15000)]);
        if (proc.exitCode === null)
            proc.kill();
    }

    /** Dismiss "save changes?" prompts that may appear (e.g. around a reload). */
    async dismissSavePrompts(ms = 4000): Promise<void> {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            if (await this.page.locator('.monaco-dialog-box').count().catch(() => 0))
                await this.dialog("Don't Save").catch(() => undefined);
            await sleep(300);
        }
    }

    async shot(name: string): Promise<string> {
        const file = path.join(this.shots, name.replace(/[^a-z0-9-]+/gi, '_') + '.png');
        await this.page.screenshot({ path: file }).catch(() => undefined);
        return file;
    }

    async escape(times = 1): Promise<void> {
        for (let i = 0; i < times; i++)
            await this.page.keyboard.press('Escape');
    }

    /** Run a command from the Command Palette by its title. */
    async command(title: string): Promise<void> {
        await this.closeQuickInput();
        await this.page.keyboard.press('Control+Shift+P');
        const input = this.page.locator('.quick-input-widget input');
        await input.waitFor({ state: 'visible' });
        await input.fill('>' + title);
        await this.page.locator('.quick-input-list .monaco-list-row', { hasText: title }).first().waitFor();
        await sleep(150);
        await this.page.keyboard.press('Enter');
        await sleep(600);
    }

    /** Whether the Command Palette offers a command in the current context. */
    async commandAvailable(title: string): Promise<boolean> {
        await this.closeQuickInput();
        await this.page.keyboard.press('Control+Shift+P');
        const input = this.page.locator('.quick-input-widget input');
        await input.waitFor({ state: 'visible' });
        await input.fill('>' + title);
        await sleep(800);
        const n = await this.page.locator('.quick-input-list .monaco-list-row', { hasText: title }).count();
        await this.page.keyboard.press('Escape');
        return n > 0;
    }

    async closeQuickInput(): Promise<void> {
        if (await this.page.locator('.quick-input-widget').isVisible().catch(() => false)) {
            await this.page.keyboard.press('Escape');
            await sleep(200);
        }
    }

    /** Put keyboard focus back into the workbench (after a reload, for instance). */
    async focusWorkbench(): Promise<void> {
        await this.page.bringToFront();
        await this.page.locator('.part.editor').first().click({ position: { x: 300, y: 300 } }).catch(() => undefined);
        await sleep(300);
    }

    /** Pick an entry in an open quick pick. */
    async pick(label: string): Promise<void> {
        const input = this.page.locator('.quick-input-widget input');
        await input.waitFor({ state: 'visible' });
        await input.fill(label);
        await this.page.locator('.quick-input-list .monaco-list-row', { hasText: label }).first().waitFor();
        await this.page.keyboard.press('Enter');
        await sleep(800);
    }

    /** Quick Open a file and wait until its tab is active (the file index can be slow on a cold start). */
    async openFile(rel: string): Promise<void> {
        const name = rel.split('/').pop()!;
        for (let attempt = 0; attempt < 3; attempt++) {
            await this.closeQuickInput();
            await this.page.keyboard.press('Control+P');
            const input = this.page.locator('.quick-input-widget input');
            await input.waitFor({ state: 'visible' });
            await input.fill(rel);
            const row = this.page.locator('.quick-input-list .monaco-list-row').first();
            await row.waitFor({ timeout: 10000 }).catch(() => undefined);
            await sleep(300);
            await this.page.keyboard.press('Enter');
            const tab = this.page.locator('.tab.active', { hasText: name }).first();
            if (await tab.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
                await sleep(400);
                return;
            }
        }
        throw new Error('could not open ' + rel);
    }

    /** Ctrl+G in whichever editor has focus. */
    async gotoLine(line: number): Promise<void> {
        await this.page.keyboard.press('Control+G');
        await this.page.locator('.quick-input-widget input').waitFor({ state: 'visible' });
        await this.page.keyboard.type(String(line));
        await this.page.keyboard.press('Enter');
        await sleep(300);
    }

    async type(text: string): Promise<void> {
        await this.page.keyboard.type(text, { delay: 5 });
    }

    /** Comment on the current selection: Command Palette, type, Ctrl+Enter. */
    async addComment(text: string): Promise<void> {
        await this.command('Comments: Add Comment on Current Selection');
        await sleep(400);
        await this.type(text);
        await this.submit();
    }

    /**
     * Comment on one line with the mouse: hover the line, click the gutter "+", type, Ctrl+Enter.
     * `scope` narrows to one editor (e.g. the right side of a diff).
     */
    async addCommentWithMouse(line: number, text: string, scope?: Locator): Promise<void> {
        const root = scope ?? this.page.locator('.editor-instance').first();
        const number = root.locator('.margin-view-overlays .line-numbers', { hasText: new RegExp(`^\s*${line}\s*$`) }).first();
        await number.waitFor();
        const box = (await number.boundingBox())!;
        const content = root.locator('.view-lines').first();
        const cbox = (await content.boundingBox())!;
        // Commenting ranges for a freshly opened editor arrive asynchronously; hover until the "+" shows.
        const glyph = root.locator('.comment-range-glyph.line-hover').first();
        for (let i = 0; i < 20 && !(await glyph.isVisible().catch(() => false)); i++) {
            await this.page.mouse.move(cbox.x + cbox.width - 5, cbox.y + 5);
            await sleep(150);
            await this.page.mouse.move(cbox.x + 30, box.y + box.height / 2);
            await sleep(350);
        }
        await glyph.click();
        await sleep(500);
        await this.type(text);
        await this.submit();
    }

    /** Whether hovering a line shows the gutter "+" (i.e. the line can take a comment). */
    async canCommentWithMouse(line: number, scope?: Locator): Promise<boolean> {
        const root = scope ?? this.page.locator('.editor-instance').first();
        const number = root.locator('.margin-view-overlays .line-numbers', { hasText: new RegExp(`^\s*${line}\s*$`) }).first();
        await number.waitFor();
        const box = (await number.boundingBox())!;
        const cbox = (await root.locator('.view-lines').first().boundingBox())!;
        const glyph = root.locator('.comment-range-glyph.line-hover').first();
        for (let i = 0; i < 8; i++) {
            await this.page.mouse.move(cbox.x + cbox.width - 5, cbox.y + 5);
            await sleep(150);
            await this.page.mouse.move(cbox.x + 30, box.y + box.height / 2);
            await sleep(350);
            if (await glyph.isVisible().catch(() => false))
                return true;
        }
        return false;
    }

    /**
     * Submit the comment being typed: Ctrl+Enter, and if an autocomplete popup swallowed it,
     * click the form's primary button the way a person would.
     */
    async submit(): Promise<void> {
        await this.page.keyboard.press('Control+Enter');
        await sleep(700);
        const pending = this.page.locator('.review-widget .comment-form .monaco-button:not(.disabled)', { hasText: /Add Review Comment|^Reply$/ }).first();
        if (await pending.isVisible().catch(() => false))
            await pending.click().catch(() => undefined);
        await sleep(600);
    }

    widget(text: string): Locator {
        return this.page.locator('.review-widget', { hasText: text }).first();
    }

    /** Click a thread or comment action by its accessible label (Resolve Thread, Edit, …). */
    async action(scope: Locator, label: string): Promise<boolean> {
        await scope.hover().catch(() => undefined);
        const a = scope.locator(`[aria-label="${label}"]`).first();
        if (!(await a.count()))
            return false;
        await a.click({ force: true });
        await sleep(800);
        return true;
    }

    async openReplyBox(w: Locator): Promise<void> {
        const button = w.locator('.review-thread-reply-button').first();
        if (await button.isVisible().catch(() => false))
            await button.click();
        else
            await w.locator('.comment-form .monaco-editor').first().click();
        await sleep(300);
    }

    async reply(w: Locator, text: string): Promise<void> {
        await this.openReplyBox(w);
        await this.type(text);
        await this.submit();
    }

    /** Every comment widget in the window with its comments. */
    async threads(): Promise<Thread[]> {
        return this.page.$$eval('.review-widget', (ws: any[]) => ws.map(w => ({
            label: (w.querySelector('.head .review-title')?.textContent || '').trim(),
            comments: [...w.querySelectorAll('.review-comment')].map((c: any) => ({
                author: (c.querySelector('.author')?.textContent || '').trim(),
                body: (c.querySelector('.comment-body')?.textContent || '').trim(),
            })),
        })));
    }

    async waitForComment(pred: (c: { author: string; body: string }) => boolean, ms = 5000): Promise<boolean> {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            if ((await this.threads()).some(t => t.comments.some(pred)))
                return true;
            await sleep(200);
        }
        return false;
    }

    /** Notification toasts currently shown. */
    async notifications(): Promise<string[]> {
        return this.page.$$eval('.notification-toast .notification-list-item-message', (els: any[]) => els.map(e => (e.textContent || '').trim()));
    }

    async clearNotifications(): Promise<void> {
        await this.command('Notifications: Clear All Notifications').catch(() => undefined);
    }

    /** Click a dialog button if a (custom-style) modal dialog is open. */
    async dialog(button: string): Promise<string | undefined> {
        const box = this.page.locator('.monaco-dialog-box');
        if (!(await box.count()))
            return undefined;
        const text = (await box.innerText().catch(() => '')) || '';
        await box.locator('.monaco-button', { hasText: button }).first().click();
        await sleep(800);
        return text.trim();
    }

    /** Click into the given side of the (first visible) diff editor showing a file, then go to a line. */
    async focusDiffSide(side: 'original' | 'modified', line: number, fileHint?: string): Promise<void> {
        const scope = fileHint
            ? this.page.locator('.multiDiffEntry', { hasText: fileHint }).first()
            : this.page.locator('.editor-instance .monaco-diff-editor').first();
        const editor = scope.locator(`.editor.${side} .view-lines`).first();
        await editor.click({ position: { x: 40, y: 5 } });
        await sleep(200);
        await this.gotoLine(line);
    }

    static tmpRoot(): string {
        return fs.mkdtempSync(path.join(os.tmpdir(), 'rc-ui-'));
    }
}
