# Shared, side-effect-free helpers for the per-user falsify:// connect launcher.
# Registry writes and deletes live only in install-connection.ps1 / uninstall-connection.ps1.
Set-StrictMode -Version 2.0

$script:Scheme = 'falsify'
$script:OwnerMarker = 'falsify-workbench/connect-launcher/v1'
$script:ProtocolDescription = 'URL:Falsify Workbench local companion'
$script:WebOrigin = 'https://shinick-han.github.io'
$script:OwnedRootValues = @('(default)', 'URL Protocol', 'FalsifyOwner', 'FalsifyScriptPath', 'FalsifyPowerShellPath')
$script:OwnedSubkeys = @('shell', 'shell\open', 'shell\open\command')

function Get-FalsifyConnectionConstants {
    [pscustomobject]@{
        Scheme = $script:Scheme
        OwnerMarker = $script:OwnerMarker
        ProtocolDescription = $script:ProtocolDescription
        WebOrigin = $script:WebOrigin
        UserClassesRoot = 'HKCU:\Software\Classes'
        MachineClassesRoot = 'HKLM:\Software\Classes'
    }
}

# Accepts exactly falsify://connect?port=<1024..65535> or its serialized equivalent
# falsify://connect/?port=<1024..65535>: Windows ShellExecute normalizes the empty authority
# path to a single root slash before passing the link, so exactly one optional empty root slash
# is allowed. No other path, double slash, userinfo, fragment, extra or repeated query keys,
# percent-decoding, whitespace, case changes, leading zeros or trailing newline.
function ConvertFrom-FalsifyConnectUri {
    param([AllowNull()][AllowEmptyString()][string]$Uri)
    $rejected = 'Rejected: not a falsify://connect?port=<1024-65535> link (or falsify://connect/?port=<1024-65535>).'
    if ([string]::IsNullOrEmpty($Uri) -or $Uri.Length -gt 40) { throw $rejected }
    $match = [regex]::Match($Uri, '\Afalsify://connect/?\?port=([1-9][0-9]{3,4})\z', [System.Text.RegularExpressions.RegexOptions]::CultureInvariant)
    if (-not $match.Success) { throw $rejected }
    [int]$port = [int]::Parse($match.Groups[1].Value, [System.Globalization.CultureInfo]::InvariantCulture)
    if ($port -lt 1024 -or $port -gt 65535) { throw 'Rejected: port must be 1024-65535.' }
    return $port
}

# Port-only links stay on ConvertFrom-FalsifyConnectUri. A click-pairing link adds exactly three
# nonces in fixed order. It still carries no bearer, password, command, model or origin.
function ConvertFrom-FalsifyConnectLink {
    param([AllowNull()][AllowEmptyString()][string]$Uri)
    $rejected = 'Rejected: not a falsify://connect port link, with optional one-time challenge, state and proof.'
    if ([string]::IsNullOrEmpty($Uri) -or $Uri.Length -gt 184) { throw $rejected }
    $pair = [regex]::Match($Uri, '\Afalsify://connect/?\?port=([1-9][0-9]{3,4})&challenge=([A-Za-z0-9_-]{43})&state=([A-Za-z0-9_-]{43})&proof=([A-Za-z0-9_-]{43})\z', [System.Text.RegularExpressions.RegexOptions]::CultureInvariant)
    if ($pair.Success) {
        [int]$port = [int]::Parse($pair.Groups[1].Value, [System.Globalization.CultureInfo]::InvariantCulture)
        if ($port -lt 1024 -or $port -gt 65535) { throw 'Rejected: port must be 1024-65535.' }
        return [pscustomobject]@{ Port = $port; Challenge = $pair.Groups[2].Value; State = $pair.Groups[3].Value; Proof = $pair.Groups[4].Value; Pairing = $true }
    }
    try { [int]$portOnly = ConvertFrom-FalsifyConnectUri -Uri $Uri } catch { throw $rejected }
    return [pscustomobject]@{ Port = $portOnly; Challenge = $null; State = $null; Proof = $null; Pairing = $false }
}

# Pure. Empty choice means the caller must show a visible dialog; it is not approval.
function Get-FalsifyApprovalDecision {
    param([Parameter(Mandatory)][string]$Origin, [AllowNull()][AllowEmptyString()][string]$Choice)
    if ($Origin -cne $script:WebOrigin) { return 'Refuse' }
    if ($Choice -ceq 'yes') { return 'Approve' }
    if ($Choice -ceq 'no') { return 'Cancel' }
    return 'Ask'
}

function Get-FalsifyPairingDirectory {
    if (-not [string]::IsNullOrEmpty($env:FALSIFY_PAIRING_DIR)) { return $env:FALSIFY_PAIRING_DIR }
    if ($env:OS -eq 'Windows_NT') {
        $root = [Environment]::GetFolderPath('LocalApplicationData')
        if ([string]::IsNullOrEmpty($root)) { throw 'Local application data is unavailable.' }
        return (Join-Path $root 'falsify-workbench\pairing')
    }
    $base = if (-not [string]::IsNullOrEmpty($env:XDG_DATA_HOME)) { $env:XDG_DATA_HOME } else { Join-Path $HOME '.local/share' }
    return (Join-Path $base 'falsify-workbench/pairing')
}

function Assert-FalsifyLocalPath {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Label)
    if (-not [System.IO.Path]::IsPathRooted($Path) -or $Path -notmatch '\A[A-Za-z]:\\') { throw "$Label must be an absolute local drive path: $Path" }
    if ($Path.IndexOfAny([char[]]@('"', '%')) -ge 0) { throw "$Label contains a quote or percent sign and cannot be registered safely: $Path" }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label does not exist: $Path" }
}

function Resolve-FalsifyPowerShellPath {
    $name = if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh.exe' } else { 'powershell.exe' }
    $path = Join-Path $PSHOME $name
    Assert-FalsifyLocalPath -Path $path -Label 'PowerShell executable'
    return $path
}

# The registered command line. Both paths are fixed and quoted; %1 is the only browser-supplied
# token and is passed as one quoted script argument after -File (never as PowerShell code).
# The click host is hidden and exits. Approval and failures use a visible dialog and the error log.
# Manual start-companion.ps1 is a separate foreground window and is not this command.
function New-FalsifyProtocolCommand {
    param([Parameter(Mandatory)][string]$PowerShellPath, [Parameter(Mandatory)][string]$ScriptPath)
    if ([System.IO.Path]::GetFileName($PowerShellPath) -notin @('powershell.exe', 'pwsh.exe')) { throw "Not a PowerShell executable: $PowerShellPath" }
    if ([System.IO.Path]::GetFileName($ScriptPath) -ne 'open-connection.ps1') { throw "Not the connect launcher: $ScriptPath" }
    Assert-FalsifyLocalPath -Path $PowerShellPath -Label 'PowerShell executable'
    Assert-FalsifyLocalPath -Path $ScriptPath -Label 'Launcher script'
    return ('"{0}" -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{1}" "%1"' -f $PowerShellPath, $ScriptPath)
}

function Get-FalsifyOwnedProtocolCommands {
    param([Parameter(Mandatory)][string]$PowerShellPath, [Parameter(Mandatory)][string]$ScriptPath)
    $hidden = '"{0}" -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{1}" "%1"' -f $PowerShellPath, $ScriptPath
    $legacy = '"{0}" -NoLogo -NoProfile -ExecutionPolicy Bypass -NoExit -File "{1}" "%1"' -f $PowerShellPath, $ScriptPath
    return @($hidden, $legacy)
}

# Read-only snapshot of the registry state that install/uninstall decisions are made from.
function Get-FalsifyProtocolState {
    param([string]$UserClassesRoot = 'HKCU:\Software\Classes', [string]$MachineClassesRoot = 'HKLM:\Software\Classes')
    $userKey = Join-Path $UserClassesRoot $script:Scheme
    $state = [ordered]@{
        UserKeyExists = $false
        MachineKeyExists = (Test-Path -LiteralPath (Join-Path $MachineClassesRoot $script:Scheme))
        RootValues = @{}
        Subkeys = @{}
    }
    if (Test-Path -LiteralPath $userKey) {
        $state.UserKeyExists = $true
        $state.RootValues = Read-FalsifyKeyValues -Path $userKey
        foreach ($child in @(Get-ChildItem -LiteralPath $userKey -Recurse -ErrorAction Stop)) {
            $relative = $child.Name.Substring($child.Name.IndexOf('\' + $script:Scheme + '\', [System.StringComparison]::OrdinalIgnoreCase) + $script:Scheme.Length + 2)
            $state.Subkeys[$relative] = Read-FalsifyKeyValues -Path $child.PSPath
        }
    }
    return [pscustomobject]$state
}

function Read-FalsifyKeyValues {
    param([Parameter(Mandatory)][string]$Path)
    $key = Get-Item -LiteralPath $Path -ErrorAction Stop
    $values = @{}
    foreach ($name in $key.GetValueNames()) {
        $label = if ($name -eq '') { '(default)' } else { $name }
        $values[$label] = [string]$key.GetValue($name, $null, 'DoNotExpandEnvironmentNames')
    }
    return $values
}

# True only for the exact layout this launcher writes, whose command matches its own recorded paths.
function Test-FalsifyOwnedRegistration {
    param([Parameter(Mandatory)]$State)
    if (-not $State.UserKeyExists) { return $false }
    $root = $State.RootValues
    if (@($root.Keys | Where-Object { $_ -notin $script:OwnedRootValues }).Count -ne 0) { return $false }
    if ($root['FalsifyOwner'] -ne $script:OwnerMarker -or $root['URL Protocol'] -ne '' -or $root['(default)'] -ne $script:ProtocolDescription) { return $false }
    $subkeys = @($State.Subkeys.Keys)
    if ($subkeys.Count -ne $script:OwnedSubkeys.Count -or @($subkeys | Where-Object { $_ -notin $script:OwnedSubkeys }).Count -ne 0) { return $false }
    if ($State.Subkeys['shell'].Count -ne 0 -or $State.Subkeys['shell\open'].Count -ne 0) { return $false }
    $command = $State.Subkeys['shell\open\command']
    if ($command.Count -ne 1 -or -not $command.ContainsKey('(default)')) { return $false }
    if ([string]::IsNullOrEmpty($root['FalsifyPowerShellPath']) -or [string]::IsNullOrEmpty($root['FalsifyScriptPath'])) { return $false }
    $owned = Get-FalsifyOwnedProtocolCommands -PowerShellPath $root['FalsifyPowerShellPath'] -ScriptPath $root['FalsifyScriptPath']
    return ($owned -contains $command['(default)'])
}

function Get-FalsifyInstallDecision {
    param([Parameter(Mandatory)]$State, [Parameter(Mandatory)][string]$ExpectedCommand)
    if ($State.MachineKeyExists) {
        return [pscustomobject]@{ Action = 'Refuse'; Reason = 'A machine-wide falsify: protocol is registered by another application. It will not be shadowed or overwritten.' }
    }
    if (-not $State.UserKeyExists) { return [pscustomobject]@{ Action = 'Create'; Reason = 'No falsify: protocol is registered for this user.' } }
    if (-not (Test-FalsifyOwnedRegistration -State $State)) {
        return [pscustomobject]@{ Action = 'Refuse'; Reason = 'HKCU\Software\Classes\falsify exists but is not this launcher''s exact registration. Nothing was changed.' }
    }
    if ($State.Subkeys['shell\open\command']['(default)'] -ceq $ExpectedCommand) {
        return [pscustomobject]@{ Action = 'AlreadyInstalled'; Reason = 'This checkout is already registered.' }
    }
    return [pscustomobject]@{ Action = 'Update'; Reason = "This launcher's registration points at $($State.RootValues['FalsifyScriptPath']); it will be re-pointed to this checkout." }
}

function Get-FalsifyUninstallDecision {
    param([Parameter(Mandatory)]$State)
    if (-not $State.UserKeyExists) { return [pscustomobject]@{ Action = 'Absent'; Reason = 'No per-user falsify: protocol registration exists.' } }
    if (-not (Test-FalsifyOwnedRegistration -State $State)) {
        return [pscustomobject]@{ Action = 'Refuse'; Reason = 'HKCU\Software\Classes\falsify is not this launcher''s exact registration. Nothing was removed.' }
    }
    return [pscustomobject]@{ Action = 'Remove'; Reason = "Removing this launcher's registration for $($State.RootValues['FalsifyScriptPath'])." }
}

# Read-only listener table check; never binds, connects to, or stops anything.
function Test-FalsifyPortAvailable {
    param([Parameter(Mandatory)][ValidateRange(1024, 65535)][int]$Port)
    $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    return (@($listeners | Where-Object { $_.Port -eq $Port }).Count -eq 0)
}

# Lists locally installed CLIs by PATH lookup only; nothing is executed or authenticated.
function Get-FalsifyCliStatus {
    foreach ($name in @('codex', 'claude')) {
        $command = Get-Command $name -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
        [pscustomobject]@{ Name = $name; Installed = [bool]$command; Path = if ($command) { $command.Source } else { $null } }
    }
}

Export-ModuleMember -Function Get-FalsifyConnectionConstants, ConvertFrom-FalsifyConnectUri, ConvertFrom-FalsifyConnectLink,
    Get-FalsifyApprovalDecision, Get-FalsifyPairingDirectory, Resolve-FalsifyPowerShellPath,
    New-FalsifyProtocolCommand, Get-FalsifyOwnedProtocolCommands, Get-FalsifyProtocolState, Test-FalsifyOwnedRegistration, Get-FalsifyInstallDecision,
    Get-FalsifyUninstallDecision, Test-FalsifyPortAvailable, Get-FalsifyCliStatus
