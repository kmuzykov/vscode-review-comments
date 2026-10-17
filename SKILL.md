---
name: review-comments
description: Process inline review comments that a human left on local files with the bundled "Review Comments" VS Code / Cursor extension, and reply to them in the same threads. Use this whenever the user asks you to go through, process, address, answer, or apply their review comments, "the comments I left", "my notes in the editor", or mentions .vscode/review-comments.json, even if they don't name the extension. Also use it when the user wants that extension installed or set up, or asks you to leave line-by-line review comments on a file for them to read in the editor.
license: MIT
compatibility: Needs VS Code or Cursor. The extension is bundled in dist/ and scripts/ installs it; no other dependencies.
metadata:
  author: Kirill Muzykov
  version: "0.2.0"
  repository: https://github.com/kmuzykov/vscode-review-comments
---

# Review Comments

A review loop between a human in the editor and you in the terminal. The human selects lines in any file, clicks the `+` in the gutter and writes a comment, as in Google Docs. Every thread is saved to `.vscode/review-comments.json` at the workspace root. You read that file, do what the comments ask, and reply inside the same threads. The extension watches the file and redraws the threads the moment you save it, so the human sees your replies next to the code without leaving the editor.

## Setup (once per machine)

Check whether the extension is installed before assuming it is:

```
code --list-extensions | grep -i kmuzykov.vscode-review-comments
cursor --list-extensions | grep -i kmuzykov.vscode-review-comments
```

If it is missing from an editor the user works in, run the installer from this skill's directory. It installs the newest `dist/*.vsix` into every editor CLI it finds on PATH (`code`, `cursor`) and is safe to re-run:

```
scripts/install_extension.ps1     # Windows
scripts/install_extension.sh      # macOS / Linux
```

If neither CLI is on PATH, tell the user how to add it (VS Code and Cursor both have a "Shell Command: Install ... in PATH" command in the Command Palette on macOS; on Windows the installer option "Add to PATH" does it) rather than trying to locate the binary yourself.

Three things about the workspace matter, because the extension only knows about the first workspace folder:

- The user should open the repository root as the single folder. The JSON lives at `<first workspace folder>/.vscode/review-comments.json` and every path inside it is relative to that folder. If the user opened a subfolder or a multi-root workspace, that is where the file will be and where paths resolve.
- You must work in the same checkout the editor has open. Agent apps often run each session in its own git worktree (Claude Code desktop puts them under `.claude/worktrees/<name>`). The comments file is not tracked, so it stays in the checkout the editor has open. Edits you make in a worktree never show up next to the comments. If `.vscode/review-comments.json` is missing at your checkout root (`git rev-parse --show-toplevel`) and `git worktree list` shows another checkout that has one, stop before touching anything. Tell the user that the editor and this session are on different checkouts, and give the two fixes: run the session in the folder the editor has open (for example `claude` in the editor's integrated terminal), or open this checkout in the editor (`code <path>`) and leave the comments there. Never write replies into one checkout and code changes into another, because the reviewer would see "done" next to unchanged code.
- Suggest adding `.vscode/review-comments.json` to `.gitignore` unless the team wants review threads shared through git. It is scratch state, and stray commits of it are noise.

## The comments file

`references/comments-file-format.md` has the full schema and a worked example. The parts you need to hold in your head:

- `threads[]`, each with `id`, `filePath` (workspace-relative, forward slashes), `range.startLine` / `range.endLine`, `resolved`, and `comments[]`.
- Line numbers are zero-based, straight from the editor API. A thread with `startLine: 41` is on line 42 as the editor and the user count it. Add one when you read the code and when you talk about it.
- Each comment has `id`, `author`, `body`, `timestamp` (ISO 8601). The human's comments carry `author: "User"`.

## Processing a review

1. **Find what is pending.** Read `.vscode/review-comments.json` at the root of your checkout; if it is not there, see the worktree note in Setup before looking anywhere else. A thread needs you when it is not resolved and its last comment was not written by you. Everything else is either waiting for the human (you already replied) or done. This rule is what lets you run the skill repeatedly on the same file without re-answering old threads, so keep your author name stable: `Claude` when you are Claude Code, `Codex` in Codex, otherwise the product name you run as.
2. **Read the code, not just the comment.** Open each file with pending threads and read the anchored lines with enough surrounding context to understand them. Comments are short because the human assumes you can see what they see. While you are there, glance at the non-pending threads in the same file: if an earlier reply of yours claims a change that is not in the code, make the change now and reply again, because a "done" that is not true is worse than a thread left open.
3. **Decide what kind of comment it is.** An instruction ("extract this", "rename to X", "handle the empty case") means make the change. A question means answer in the thread and leave the code alone; when the code does not contain the answer, say what you can and cannot tell from it rather than inventing a rationale. If you think a request is wrong, say so in the reply with the reason and what you would do instead; do not silently comply and do not silently skip. The thread is the place for that conversation.
4. **Make the edits** with your normal tools, file by file. Keep each change scoped to what the thread asked; an unrelated cleanup you noticed belongs in your chat summary, not in the edit.
5. **Reply in every pending thread.** Append a comment with a fresh `id`, your author name, an ISO timestamp, and a short body: what you changed, or the answer, or the pushback. One or two sentences for a plain "done"; a little more when the answer needs a caveat or you are disagreeing, since a reason without its evidence is not much of a reason. The human will read the diff themselves, so do not paste code into the reply unless the answer is a snippet.
6. **Leave `resolved` as it is.** Resolving is the reviewer's acknowledgement that they checked your reply, and the sidebar's unresolved count is their queue. When the human replies to a resolved thread, the extension reopens it, so it becomes pending again by the rule in step 1.
7. **Fix the anchors.** Your edits move lines. After editing a file, recompute `startLine` and `endLine` for every thread in that file, including threads you did not touch and resolved ones, so each still points at the code it was about. The extension redraws everything from the JSON, so stale ranges put comments on the wrong lines. If the anchored code no longer exists, anchor the thread to where it used to be and say in the reply that the code was removed.
8. **Write the file back** as a whole: parse, modify, serialise with two-space indentation and a trailing newline, using any JSON-capable runtime you have (`node`, `uv run python`, a JSON tool) run from the shell, never `sed` or a regex on the raw text. Do not use Claude Code's Write or Edit tools for this file: they treat anything under `.vscode/` as sensitive and stop for approval on every save, even when an allow rule covers the path. Keep every existing `id` and any field you do not recognise. A reformatted file is fine: the extension itself writes with two-space indentation and expands `range` over several lines, so a formatting diff means nothing. Save once per file or once per batch; each save triggers a redraw in the editor. Then re-parse what you wrote, because a broken file shows up in the editor as "no comments" with no error, and run the smallest relevant check on the code you changed (the file's tests, a compile, an import).
9. **Summarise in chat.** One line per thread in the form `path:line` plus what you did, and a separate line for anything you pushed back on or could not do. The user may be reading the chat, not the editor, and the summary is how they know what to look at.

When nothing is pending, say so and give the counts: threads waiting for the human, threads resolved.

## Ids

Any short unique string works; the extension uses eight or more base-36 characters. Something like `Math.random().toString(36).slice(2, 10) + Date.now().toString(36)`, or a UUID, is fine. Uniqueness within the file is all that matters.

## Leaving comments yourself

The same file works in the other direction. When the user asks you to review a file and leave notes they can read in the editor, create threads with your author name, one per finding, anchored to the exact lines. The human replies or resolves in the editor, and any reply makes the thread pending for you again.
