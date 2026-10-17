# Review Comments (VS Code extension)

Google Docs-style inline comment threads on any local file. Click the `+` in the gutter (or select lines and run **Comments: Add Comment on Current Selection**), write a comment, reply, resolve. Threads are stored in `.vscode/review-comments.json` at the workspace root so a coding agent can read them and reply in the same file; replies appear in the editor as soon as the file is saved.

- **Compare with Branch…** (Command Palette or the Comments view title bar) shows every file that differs from a branch, such as `main`, in a multi-file diff whose right-hand side is the real file: you can comment on it and edit it there.
- Threads also show, and take new comments, on the right-hand side of VS Code's own diff and branch-compare views when that side is identical to the file on disk. Older versions (the left-hand side) cannot be commented on, because their line numbers do not match the file.
- Threads follow the code while you edit: typing above a thread moves it, and the new line is written to the file when you save. Renaming or moving a file or folder in VS Code updates the thread paths.
- Replying to a resolved thread reopens it. Deleting a thread asks first.
- If the comments file becomes invalid (for example half-written by another tool), the editor keeps showing the last good version, warns once, and refuses to save until the file is valid again, so nothing is overwritten.

Only the first folder of a multi-root workspace is used, and only files inside it can be commented on.

Source and agent skill: https://github.com/kmuzykov/vscode-review-comments

## Development

```
npm install
npm test                  # unit tests (plain Node)
npm run test:integration  # inside a real VS Code, through the extension API
npm run test:ui           # drives a real VS Code window with Playwright
npm run package           # writes ../dist/vscode-review-comments-<version>.vsix
```

The integration and UI tests download VS Code once into `%TEMP%/rc-vscode-test` (override with `RC_VSCODE_CACHE`; `RC_VSCODE_VERSION` picks the version, default `stable`). The UI test opens a separate VS Code window and types into it; it does not touch your own VS Code profile. `RC_KEEP=1` keeps its screenshots and workspace.
