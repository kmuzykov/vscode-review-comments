/**
 * Pure data logic for the comments file: parsing, validation, normalisation and anchor shifting.
 * No dependency on the vscode module, so it is unit-tested with plain Node.
 */

/** A single comment within a thread. */
export interface StoredComment {
    id: string;
    author: string;
    body: string;
    timestamp: string;
}

/** A comment thread attached to a file range. Lines are zero-based and inclusive. */
export interface StoredThread {
    id: string;
    filePath: string;
    range: { startLine: number; endLine: number };
    resolved: boolean;
    comments: StoredComment[];
}

/** The author name the extension writes for the human in the editor. */
export const USER_AUTHOR = 'User';

export type ParseResult =
    | { ok: true; raw: RawData; threads: StoredThread[]; problems: string[] }
    | { ok: false; error: string };

/** The file as parsed, with unknown fields kept so that writing it back loses nothing. */
export interface RawData {
    threads: any[];
    [key: string]: unknown;
}

/**
 * Parse the text of the comments file. An empty or whitespace-only file counts as no threads.
 * Threads that cannot be displayed are left in `raw` (so they survive a rewrite) but are not
 * returned in `threads`; each one adds a line to `problems`.
 */
export function parseCommentsFile(text: string): ParseResult {
    const clean = text.replace(/^﻿/, '');
    if (clean.trim() === '')
        return { ok: true, raw: { threads: [] }, threads: [], problems: [] };

    let raw: any;
    try {
        raw = JSON.parse(clean);
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return { ok: false, error: 'top level is not an object' };
    if (raw.threads === undefined)
        raw.threads = [];
    if (!Array.isArray(raw.threads))
        return { ok: false, error: '"threads" is not an array' };

    const threads: StoredThread[] = [];
    const problems: string[] = [];
    const seen = new Set<string>();
    raw.threads.forEach((t: any, i: number) => {
        const thread = normaliseThread(t);
        if (typeof thread === 'string') {
            problems.push(`thread #${i + 1}: ${thread}`);
            return;
        }
        if (seen.has(thread.id)) {
            problems.push(`thread #${i + 1}: duplicate id "${thread.id}"`);
            return;
        }
        seen.add(thread.id);
        threads.push(thread);
    });
    return { ok: true, raw: raw as RawData, threads, problems };
}

/** Validate one raw thread; returns the reason as a string when it cannot be shown. */
function normaliseThread(t: any): StoredThread | string {
    if (typeof t !== 'object' || t === null)
        return 'not an object';
    if (typeof t.id !== 'string' || t.id === '')
        return 'missing "id"';
    if (typeof t.filePath !== 'string' || t.filePath.trim() === '')
        return 'missing "filePath"';
    if (!Array.isArray(t.comments) || t.comments.length === 0)
        return 'has no comments';

    let start = toLine(t.range?.startLine);
    let end = toLine(t.range?.endLine ?? t.range?.startLine);
    if (start === undefined)
        return 'missing "range.startLine"';
    if (end === undefined)
        end = start;
    if (end < start)
        [start, end] = [end, start];

    const comments: StoredComment[] = [];
    for (const c of t.comments) {
        if (typeof c !== 'object' || c === null || typeof c.body !== 'string')
            return 'a comment has no "body"';
        comments.push({
            id: typeof c.id === 'string' && c.id ? c.id : `${t.id}-${comments.length}`,
            author: typeof c.author === 'string' && c.author ? c.author : 'Unknown',
            body: c.body,
            timestamp: typeof c.timestamp === 'string' ? c.timestamp : '',
        });
    }

    return {
        id: t.id,
        filePath: normaliseFilePath(t.filePath),
        range: { startLine: start, endLine: end },
        resolved: t.resolved === true,
        comments,
    };
}

function toLine(v: unknown): number | undefined {
    if (typeof v !== 'number' || !Number.isFinite(v))
        return undefined;
    return Math.max(0, Math.floor(v));
}

/** Forward slashes, no leading "./". Absolute paths are kept as they are. */
export function normaliseFilePath(p: string): string {
    return p.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '');
}

/** Serialise the way the extension always has: two-space indent and a trailing newline. */
export function serialise(raw: RawData): string {
    return JSON.stringify(raw, null, 2) + '\n';
}

/** A thread is waiting for the agent when it is open and the human spoke last. */
export function lastAuthor(thread: StoredThread): string {
    return thread.comments[thread.comments.length - 1]?.author ?? '';
}

/** One text edit, in line/character coordinates of the document before the edit. */
export interface LineEdit {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
    text: string;
}

/**
 * Move a zero-based inclusive line range so it keeps pointing at the same code after an edit.
 * Edits entirely above shift it, edits entirely below leave it alone, edits that overlap it
 * grow or shrink it. Lines that are deleted outright pull the range to where they were.
 */
export function shiftRange(range: { startLine: number; endLine: number }, edit: LineEdit): { startLine: number; endLine: number } {
    const added = (edit.text.match(/\n/g) || []).length;
    const delta = added - (edit.endLine - edit.startLine);
    if (delta === 0 && edit.endLine === edit.startLine)
        return range;

    const { startLine: rs, endLine: re } = range;
    // Inserting whole lines at the very start of the first anchored line pushes it down.
    const pushesDown = edit.startLine === rs && edit.endLine === rs && edit.startCharacter === 0
        && edit.endCharacter === 0 && edit.text.endsWith('\n');

    if (edit.endLine < rs || pushesDown)
        return { startLine: rs + delta, endLine: re + delta };
    if (edit.startLine > re)
        return range;

    // Overlap: an edit starting above the range takes its first lines with it.
    const start = Math.min(rs, edit.startLine);
    const end = Math.max(start, re + delta);
    return { startLine: Math.max(0, start), endLine: Math.max(0, end) };
}

/** Apply several edits from one change event (all in pre-edit coordinates). */
export function shiftRangeByEdits(range: { startLine: number; endLine: number }, edits: LineEdit[]): { startLine: number; endLine: number } {
    const sorted = [...edits].sort((a, b) => b.startLine - a.startLine || b.startCharacter - a.startCharacter);
    return sorted.reduce((r, e) => shiftRange(r, e), range);
}

/** Rewrite a workspace-relative path after a file or folder rename; undefined if unaffected. */
export function renamedPath(filePath: string, oldRel: string, newRel: string, caseInsensitive: boolean): string | undefined {
    const fp = caseInsensitive ? filePath.toLowerCase() : filePath;
    const old = caseInsensitive ? oldRel.toLowerCase() : oldRel;
    if (fp === old)
        return newRel;
    if (fp.startsWith(old + '/'))
        return newRel + filePath.substring(oldRel.length);
    return undefined;
}

/** Short random id, the same shape the extension has always used. */
export function generateId(): string {
    return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}
