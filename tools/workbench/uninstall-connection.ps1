<#
Removes the per-user falsify:// protocol registration written by install-connection.ps1.
It deletes nothing unless HKCU\Software\Classes\falsify is exactly that registration, and it
removes the four known keys one by one (never a recursive delete). Use -WhatIf to preview.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param()
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'falsify-connection.psm1') -Force

$constants = Get-FalsifyConnectionConstants
$decision = Get-FalsifyUninstallDecision -State (Get-FalsifyProtocolState)
Write-Host $decision.Reason
if ($decision.Action -eq 'Refuse') { throw 'Uninstall refused.' }
if ($decision.Action -eq 'Absent') { return }

$userKey = Join-Path $constants.UserClassesRoot $constants.Scheme
if ($PSCmdlet.ShouldProcess("HKCU\Software\Classes\$($constants.Scheme)", 'Remove per-user falsify: protocol')) {
    foreach ($relative in @('shell\open\command', 'shell\open', 'shell')) {
        Remove-Item -LiteralPath (Join-Path $userKey $relative)
    }
    Remove-Item -LiteralPath $userKey
    Write-Host 'Removed. The project folder and its .venv are untouched.'
}
