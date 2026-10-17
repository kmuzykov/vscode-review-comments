import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { normaliseFilePath, parseCommentsFile, renamedPath, serialise, shiftRange, shiftRangeByEdits } from '../../model';

const thread = (over: object = {}) => ({
    id: 't1', filePath: 'src/a.py', range: { startLine: 4, endLine: 6 }, resolved: false,
    comments: [{ id: 'c1', author: 'User', body: 'hi', timestamp: '2026-01-01T00:00:00.000Z' }],
    ...over,
});

test('parses a file the extension wrote', () => {
    const r = parseCommentsFile(serialise({ threads: [thread()] }));
    assert.ok(r.ok);
    assert.equal(r.threads.length, 1);
    assert.deepEqual(r.threads[0].range, { startLine: 4, endLine: 6 });
    assert.deepEqual(r.problems, []);
});

test('empty and whitespace-only files mean no threads', () => {
    for (const text of ['', '  \n', '﻿']) {
        const r = parseCommentsFile(text);
        assert.ok(r.ok && r.threads.length === 0, JSON.stringify(text));
    }
});

test('a UTF-8 BOM (Windows PowerShell 5.1 writes one) is accepted', () => {
    const r = parseCommentsFile('﻿' + JSON.stringify({ threads: [thread()] }));
    assert.ok(r.ok && r.threads.length === 1);
});

test('broken JSON is reported, never treated as empty', () => {
    for (const text of ['{', '{"threads": [', 'null', '[]', '{"threads": 5}', '{"threads": [{"id": "x",']) {
        const r = parseCommentsFile(text);
        assert.equal(r.ok, false, text);
    }
});

test('a missing threads key is an empty list', () => {
    const r = parseCommentsFile('{}');
    assert.ok(r.ok && r.threads.length === 0);
});

test('threads that cannot be shown are reported but kept in raw for the next write', () => {
    const bad = [{ id: 'nocomments', filePath: 'a', range: { startLine: 0, endLine: 0 }, comments: [] }, { filePath: 'a' }, 'junk'];
    const r = parseCommentsFile(JSON.stringify({ threads: [thread(), ...bad] }));
    assert.ok(r.ok);
    assert.equal(r.threads.length, 1);
    assert.equal(r.problems.length, 3);
    assert.equal(r.raw.threads.length, 4);
});

test('duplicate ids: the first wins, the duplicate is reported', () => {
    const r = parseCommentsFile(JSON.stringify({ threads: [thread(), thread({ filePath: 'other' })] }));
    assert.ok(r.ok);
    assert.equal(r.threads.length, 1);
    assert.equal(r.threads[0].filePath, 'src/a.py');
    assert.match(r.problems[0], /duplicate/);
});

test('paths are normalised: backslashes, ./ prefix', () => {
    assert.equal(normaliseFilePath('src\\sub\\a.py'), 'src/sub/a.py');
    assert.equal(normaliseFilePath('./src/a.py'), 'src/a.py');
    const r = parseCommentsFile(JSON.stringify({ threads: [thread({ filePath: '.\\src\\a.py' })] }));
    assert.ok(r.ok && r.threads[0].filePath === 'src/a.py');
});

test('ranges are repaired: missing endLine, reversed, negative, fractional', () => {
    const parse = (range: object) => {
        const r = parseCommentsFile(JSON.stringify({ threads: [thread({ range })] }));
        assert.ok(r.ok);
        return r.threads[0]?.range;
    };
    assert.deepEqual(parse({ startLine: 3 }), { startLine: 3, endLine: 3 });
    assert.deepEqual(parse({ startLine: 9, endLine: 2 }), { startLine: 2, endLine: 9 });
    assert.deepEqual(parse({ startLine: -4, endLine: 1.7 }), { startLine: 0, endLine: 1 });
    assert.equal(parse({ endLine: 1 }), undefined);
});

test('unknown fields survive a parse/serialise round trip', () => {
    const data = { version: 2, threads: [thread({ tags: ['x'], comments: [{ id: 'c', author: 'Claude', body: 'b', timestamp: '', model: 'opus' }] })] };
    const r = parseCommentsFile(JSON.stringify(data));
    assert.ok(r.ok);
    assert.deepEqual(JSON.parse(serialise(r.raw)), data);
});

test('comments without ids or authors get stable defaults', () => {
    const r = parseCommentsFile(JSON.stringify({ threads: [thread({ comments: [{ body: 'x' }, { body: 'y', author: '' }] })] }));
    assert.ok(r.ok);
    assert.deepEqual(r.threads[0].comments.map(c => [c.id, c.author]), [['t1-0', 'Unknown'], ['t1-1', 'Unknown']]);
});

const edit = (startLine: number, startCharacter: number, endLine: number, endCharacter: number, text: string) =>
    ({ startLine, startCharacter, endLine, endCharacter, text });
const R = (startLine: number, endLine: number) => ({ startLine, endLine });

test('shiftRange: lines inserted above move the range down', () => {
    assert.deepEqual(shiftRange(R(10, 12), edit(3, 5, 3, 5, '\nnew\n')), R(12, 14));
});

test('shiftRange: Enter at the end of the line above', () => {
    assert.deepEqual(shiftRange(R(10, 10), edit(9, 20, 9, 20, '\n')), R(11, 11));
});

test('shiftRange: a line inserted at column 0 of the first anchored line pushes it down', () => {
    assert.deepEqual(shiftRange(R(10, 12), edit(10, 0, 10, 0, 'x = 1\n')), R(11, 13));
});

test('shiftRange: typing inside the range does not move it', () => {
    assert.deepEqual(shiftRange(R(10, 12), edit(11, 3, 11, 3, 'abc')), R(10, 12));
});

test('shiftRange: a newline typed inside the range grows it', () => {
    assert.deepEqual(shiftRange(R(10, 12), edit(11, 3, 11, 3, '\n')), R(10, 13));
});

test('shiftRange: edits below the range do nothing', () => {
    assert.deepEqual(shiftRange(R(10, 12), edit(20, 0, 25, 0, '')), R(10, 12));
});

test('shiftRange: lines deleted above move the range up', () => {
    assert.deepEqual(shiftRange(R(10, 12), edit(2, 0, 5, 0, '')), R(7, 9));
});

test('shiftRange: deleting the whole range collapses it to where it was', () => {
    assert.deepEqual(shiftRange(R(10, 12), edit(10, 0, 13, 0, '')), R(10, 10));
});

test('shiftRange: a deletion that starts above and ends inside pulls the start up', () => {
    assert.deepEqual(shiftRange(R(10, 12), edit(8, 0, 11, 0, '')), R(8, 9));
});

test('shiftRangeByEdits: several edits from one event (multi-cursor) in any order', () => {
    const edits = [edit(2, 0, 2, 0, 'a\n'), edit(20, 0, 20, 0, 'b\n'), edit(5, 0, 5, 0, 'c\n')];
    assert.deepEqual(shiftRangeByEdits(R(10, 12), edits), R(12, 14));
    assert.deepEqual(shiftRangeByEdits(R(10, 12), [...edits].reverse()), R(12, 14));
});

test('renamedPath: file and folder renames, case handling', () => {
    assert.equal(renamedPath('src/a.py', 'src/a.py', 'src/b.py', false), 'src/b.py');
    assert.equal(renamedPath('src/sub/a.py', 'src', 'lib', false), 'lib/sub/a.py');
    assert.equal(renamedPath('src2/a.py', 'src', 'lib', false), undefined);
    assert.equal(renamedPath('SRC/a.py', 'src', 'lib', false), undefined);
    assert.equal(renamedPath('SRC/a.py', 'src', 'lib', true), 'lib/a.py');
});
