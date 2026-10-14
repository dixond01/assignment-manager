# Point the "Assignment Manager" shortcuts at the current icon.
# Windows caches shortcut icons by file path, so after regenerating public/icon.ico the old icon keeps
# showing. This copies the icon to a path named by its content hash (in data/, which is gitignored)
# and points the Desktop shortcut and any taskbar pin at that new path.
#
# Usage:  powershell -ExecutionPolicy Bypass -File tools\update_shortcut.ps1 [-Source <icon.ico>]
#         (default source: public\icon.ico; the server passes the icon drawn in the active theme's colors)

param([string]$Source)

$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent $PSScriptRoot
$source = if ($Source) { $Source } else { Join-Path $app 'public\icon.ico' }
$dataDir = Join-Path $app 'data'
New-Item -ItemType Directory -Force $dataDir | Out-Null

$hash = (Get-FileHash $source -Algorithm SHA256).Hash.Substring(0, 8).ToLower()
$target = Join-Path $dataDir "shortcut-icon-$hash.ico"
Copy-Item $source $target -Force

# Remove copies of older icons this script made.
Get-ChildItem $dataDir -Filter 'shortcut-icon-*.ico' | Where-Object { $_.FullName -ne $target } | Remove-Item -Confirm:$false

$shell = New-Object -ComObject WScript.Shell
$links = @(Join-Path ([Environment]::GetFolderPath('Desktop')) 'Assignment Manager.lnk')
$pinDir = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
if (Test-Path $pinDir) {
    $links += Get-ChildItem $pinDir -Filter '*.lnk' |
        Where-Object { $shell.CreateShortcut($_.FullName).Arguments -like '*assignment-manager*' } |
        ForEach-Object { $_.FullName }
}

foreach ($link in $links | Where-Object { Test-Path $_ }) {
    $shortcut = $shell.CreateShortcut($link)
    $shortcut.IconLocation = "$target,0"
    $shortcut.Save()
    Write-Output "Updated $link"
}

& "$env:WINDIR\System32\ie4uinit.exe" -show
Write-Output "Icon: $target"
