#!/usr/bin/env sh
# Installs the newest dist/*.vsix into every editor CLI found on PATH (code, cursor).
# Safe to re-run; --force reinstalls over an existing version.
set -eu
dist="$(cd "$(dirname "$0")/../dist" && pwd)"
vsix="$(ls -t "$dist"/*.vsix 2>/dev/null | head -n 1 || true)"
if [ -z "$vsix" ]; then
    echo "No .vsix found in $dist. Build one with: cd extension && npm install && npm run package" >&2
    exit 1
fi
found=0
for editor in code cursor; do
    if command -v "$editor" >/dev/null 2>&1; then
        found=1
        echo "Installing $(basename "$vsix") into $editor"
        "$editor" --install-extension "$vsix" --force
    fi
done
if [ "$found" -eq 0 ]; then
    echo "Neither 'code' nor 'cursor' is on PATH. Add the editor's CLI to PATH (Command Palette: 'Shell Command: Install ... command in PATH' on macOS) and re-run." >&2
    exit 1
fi
