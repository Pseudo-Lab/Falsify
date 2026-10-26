<#
Registers the per-user falsify:// protocol so the website's "connect" link can open
open-connection.ps1 from THIS checkout. The registered host is hidden and exits. The approval
dialog and the error log stay visible. A legacy exact -NoExit command for this launcher is
upgraded. Manual start-companion.ps1 stays a foreground window. Run the installer once, yourself.
Writes only HKCU\Software\Classes\falsify (no administrator rights, no startup entries,
no services). Use -WhatIf to see the plan without changing anything.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param()
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'falsify-connection.psm1') -Force

$constants = Get-FalsifyConnectionConstants
$scriptPath = Join-Path $PSScriptRoot 'open-connection.ps1'
$powerShellPath = Resolve-FalsifyPowerShellPath
$command = New-FalsifyProtocolCommand -PowerShellPath $powerShellPath -ScriptPath $scriptPath
$decision = Get-FalsifyInstallDecision -State (Get-FalsifyProtocolState) -ExpectedCommand $command

Write-Host "Protocol command: $command"
Write-Host $decision.Reason
if ($decision.Action -eq 'Refuse') { throw 'Install refused. Use the manual start-companion.ps1 route instead.' }
if ($decision.Action -eq 'AlreadyInstalled') { return }

$userKey = Join-Path $constants.UserClassesRoot $constants.Scheme
$commandKey = Join-Path $userKey 'shell\open\command'
if ($PSCmdlet.ShouldProcess("HKCU\Software\Classes\$($constants.Scheme)", 'Register per-user falsify: protocol')) {
    foreach ($key in @($userKey, (Join-Path $userKey 'shell'), (Join-Path $userKey 'shell\open'), $commandKey)) {
        if (-not (Test-Path -LiteralPath $key)) { $null = New-Item -Path $key }
    }
    Set-ItemProperty -LiteralPath $userKey -Name '(default)' -Value $constants.ProtocolDescription
    Set-ItemProperty -LiteralPath $userKey -Name 'URL Protocol' -Value ''
    Set-ItemProperty -LiteralPath $userKey -Name 'FalsifyOwner' -Value $constants.OwnerMarker
    Set-ItemProperty -LiteralPath $userKey -Name 'FalsifyScriptPath' -Value $scriptPath
    Set-ItemProperty -LiteralPath $userKey -Name 'FalsifyPowerShellPath' -Value $powerShellPath
    Set-ItemProperty -LiteralPath $commandKey -Name '(default)' -Value $command
    if (-not (Test-FalsifyOwnedRegistration -State (Get-FalsifyProtocolState))) { throw 'Registration did not verify. Run uninstall-connection.ps1 and use the manual route.' }
    Write-Host 'Installed. Do not move or rename this folder; if you do, run uninstall-connection.ps1 and install again from the new location.'
    Write-Host 'Your browser will ask before opening PowerShell each time unless you choose to remember it for this site.'
}
