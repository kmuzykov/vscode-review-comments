# Installs the newest dist/*.vsix into every editor CLI found on PATH (code, cursor).
# Safe to re-run; --force reinstalls over an existing version.
$ErrorActionPreference = 'Stop'
$dist = Join-Path $PSScriptRoot '..\dist'
$vsix = Get-ChildItem -Path $dist -Filter *.vsix -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $vsix) {
    throw "No .vsix found in $dist. Build one with: cd extension; npm install; npm run package"
}
$editors = @('code', 'cursor') | Where-Object { Get-Command $_ -ErrorAction SilentlyContinue }
if (-not $editors) {
    throw "Neither 'code' nor 'cursor' is on PATH. Add the editor's CLI to PATH (Command Palette: 'Shell Command: Install ... command in PATH' on macOS; the 'Add to PATH' installer option on Windows) and re-run."
}
foreach ($editor in $editors) {
    Write-Host "Installing $($vsix.Name) into $editor"
    & $editor --install-extension $vsix.FullName --force
    if ($LASTEXITCODE -ne 0) { throw "$editor --install-extension failed with exit code $LASTEXITCODE" }
}
