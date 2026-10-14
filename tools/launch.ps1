# Open the Assignment Manager: start the server hidden if it isn't already running, then open the app
# in the default browser. The server stops itself about a minute after its last tab closes.
#
# The Desktop shortcut runs this with no console window:
#   conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\launch.ps1
# Server output goes to data\server.log and data\server-error.log.

param(
    [int]$Port = 3456,
    [switch]$NoBrowser # for testing
)

$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent $PSScriptRoot
$url = "http://localhost:$Port"

# Any HTTP response (even an error status) means something is already serving the app.
# Check 127.0.0.1, not localhost: Windows PowerShell tries IPv6 (::1) first and times out, since the
# server only listens on IPv4.
function Test-Server {
    try {
        Invoke-WebRequest "http://127.0.0.1:$Port/api/ping" -UseBasicParsing -TimeoutSec 2 | Out-Null
        return $true
    } catch {
        return $null -ne $_.Exception.Response
    }
}

if (-not (Test-Server)) {
    $data = Join-Path $app 'data'
    New-Item -ItemType Directory -Force $data | Out-Null
    $env:PORT = "$Port"
    Start-Process -FilePath (Get-Command node).Source -ArgumentList 'server.js' -WorkingDirectory $app `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $data 'server.log') `
        -RedirectStandardError (Join-Path $data 'server-error.log')
    # Wait up to ~10 seconds for it to start listening.
    for ($i = 0; $i -lt 50 -and -not (Test-Server); $i++) { Start-Sleep -Milliseconds 200 }
}

if (-not $NoBrowser) { Start-Process $url }
