import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * A small git repository for tests: `main` with a few files, `feature` checked out with changes
 * (two lines inserted near the top of src/app.py, one changed, one new file).
 */
export function makeWorkspace(dir: string): string {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'core.autocrlf=false', ...args], { cwd: dir, stdio: 'pipe' });

    const app: string[] = [];
    for (let i = 1; i <= 40; i++)
        app.push(`def f${i}(x):  # line ${i}`);
    fs.writeFileSync(path.join(dir, 'src', 'app.py'), app.join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'src', 'util.py'), 'a = 1\nb = 2\nc = 3\nd = 4\ne = 5\n');
    fs.writeFileSync(path.join(dir, 'docs', 'notes with space.md'), '# Notes\n\nfirst\nsecond\nthird\n');
    fs.writeFileSync(path.join(dir, 'src', 'ünïcode файл.py'), 'a = 1\nb = 2\nc = 3\n');
    fs.writeFileSync(path.join(dir, 'empty.txt'), '');
    fs.writeFileSync(path.join(dir, '.gitignore'), '.vscode/review-comments.json\n');
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-qm', 'main');
    git('checkout', '-q', '-b', 'feature');
    const app2 = app.slice();
    app2.splice(5, 0, 'NEW_A = 1  # added on feature', 'NEW_B = 2  # added on feature');
    app2[20] = 'def f19_changed(x):  # changed on feature';
    fs.writeFileSync(path.join(dir, 'src', 'app.py'), app2.join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'src', 'new.py'), 'print("new on feature")\nprint("second")\n');
    git('add', '-A');
    git('commit', '-qm', 'feature');
    return dir;
}
