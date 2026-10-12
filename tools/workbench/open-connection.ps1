<#
Target of the per-user falsify:// protocol. Windows passes the clicked link as the single
argument. Only falsify://connect?port=<1024-65535> is accepted, plus the identical link with
one empty root slash (falsify://connect/?port=<1024-65535>), which is how Windows ShellExecute
actually passes it. Anything else stops here, before any network, Python, model or child
process. The link carries no token, origin, command, CLI or model: the companion always pairs
with the fixed hosted website origin.
#>
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'falsify-connection.psm1') -Force

if ($args.Count -ne 1) { throw 'Rejected: expected exactly one falsify://connect?port=<1024-65535> (or falsify://connect/?port=<1024-65535>) link.' }
[int]$port = ConvertFrom-FalsifyConnectUri -Uri ([string]$args[0])
$Host.UI.RawUI.WindowTitle = "Falsify local companion (port $port)"
Write-Host "Falsify connect link accepted for 127.0.0.1 port $port."
$launcher = Join-Path $PSScriptRoot 'start-companion.ps1'
if ($env:FALSIFY_CONNECT_DRY_RUN -eq '1') {
    Write-Output "DRY-RUN start-companion port=$port launcher=$launcher"
    return
}
& $launcher -Port $port
