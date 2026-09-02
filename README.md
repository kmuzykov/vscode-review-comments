# Review Comments

Line-by-line review comments on local files, shared between you in VS Code (or Cursor) and a coding agent in the terminal.

You select lines, click `+` in the gutter and write a comment, the way you would in Google Docs. The agent reads the threads from `.vscode/review-comments.json`, makes the changes or answers, and replies inside the same threads. The editor redraws them as soon as the file is saved, so the whole review happens next to the code.

The repository is an [Agent Skill](https://agentskills.io): `SKILL.md` tells the agent how to run the loop, `dist/` carries the packaged VS Code extension, and `scripts/` installs it. Any agent that loads the skill can set up its own editor side.

## Install

**Claude Code** (the repository is its own plugin marketplace):

```
claude plugin marketplace add kmuzykov/vscode-review-comments
claude plugin install review-comments@kmuzykov
```

**Codex** and other agents that follow the Agent Skills spec: clone or copy this repository into the agent's skills directory, for example `.agents/skills/review-comments` in a repository or `~/.agents/skills/review-comments` for all repositories.

**The editor extension** is installed by the agent the first time the skill runs, or by hand:

```
scripts/install_extension.ps1   # Windows
scripts/install_extension.sh    # macOS / Linux
```

Both pick the newest `dist/*.vsix` and install it into every editor CLI found on PATH (`code`, `cursor`).

## Use

1. Open the repository root as the single workspace folder.
2. Open any file, select lines, click `+` in the gutter, write the comment. Threads also appear in the "Review Comments" view in the Activity Bar.
3. Ask the agent to process the review comments. It replies in each thread and leaves the threads open.
4. Read the replies and diffs, resolve threads you are happy with, reply to the ones you are not.

Consider adding `.vscode/review-comments.json` to `.gitignore`; it is scratch state.

## Layout

```
SKILL.md                      agent instructions (Agent Skills spec, six-field frontmatter)
references/                   comments file format with a worked example
scripts/                      extension installers
dist/                         packaged extension (.vsix)
extension/                    extension source (TypeScript)
.claude-plugin/               Claude Code plugin and marketplace manifests
```

## Develop the extension

```
cd extension
npm install
npm run compile      # tsc
npm run package      # writes dist/vscode-review-comments-<version>.vsix
```

Bump `version` in `extension/package.json` and `.claude-plugin/plugin.json` together, rebuild, and commit the new `.vsix`.

## License

MIT
