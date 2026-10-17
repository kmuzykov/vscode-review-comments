/*
 * Runs src/test/integration/suite.ts inside a real VS Code (downloaded once and cached).
 *   npm run test:integration
 * Environment: RC_VSCODE_VERSION (default "stable"), RC_VSCODE_CACHE (default <tmp>/rc-vscode-test,
 * kept short because the VS Code archive does not extract under long Windows paths).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';
import { makeWorkspace } from './workspace';

async function main(): Promise<void> {
    const extensionDevelopmentPath = path.resolve(__dirname, '../..');
    const cache = process.env.RC_VSCODE_CACHE ?? path.join(os.tmpdir(), 'rc-vscode-test');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-int-'));
    const ws = makeWorkspace(path.join(root, 'ws'));
    try {
        await runTests({
            version: process.env.RC_VSCODE_VERSION ?? 'stable',
            cachePath: cache,
            extensionDevelopmentPath,
            extensionTestsPath: path.join(__dirname, 'integration', 'suite.js'),
            launchArgs: [ws, '--user-data-dir', path.join(root, 'ud'), '--extensions-dir', path.join(root, 'ext'), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    }
}

main().catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
