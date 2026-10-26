<#
Dry-run tests for the falsify:// connect launcher. They never write the registry, never start
the companion, never open a terminal window, never call a model and never contact the network.
Run: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-connection.ps1
(also under pwsh). Exit code 0 means every check passed.
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Import-Module (Join-Path $root 'falsify-connection.psm1') -Force
$powerShell = Resolve-FalsifyPowerShellPath
$script:failures = 0
$script:checks = 0

function Check([string]$Name, [bool]$Condition) {
    $script:checks++
    if ($Condition) { Write-Host "ok   $Name" } else { $script:failures++; Write-Host "FAIL $Name" }
}

function Invoke-Child([string[]]$Arguments, [hashtable]$Environment = @{}) {
    $saved = @{}
    foreach ($name in $Environment.Keys) { $saved[$name] = [Environment]::GetEnvironmentVariable($name); [Environment]::SetEnvironmentVariable($name, $Environment[$name]) }
    try {
        $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        $output = & $powerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass @Arguments 2>&1 | Out-String
        $exitCode = $LASTEXITCODE; $ErrorActionPreference = $previous
        return [pscustomobject]@{ ExitCode = $exitCode; Output = $output }
    } finally {
        foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
    }
}

function Test-Rejected([AllowNull()][string]$Uri) {
    try { $null = ConvertFrom-FalsifyConnectUri -Uri $Uri; return $false } catch { return $true }
}

function Test-Throws([scriptblock]$Block) {
    try { $null = & $Block; return $false } catch { return $true }
}

# --- PowerShell syntax of every launcher file -------------------------------------------
foreach ($file in @('falsify-connection.psm1', 'companion-lifecycle.psm1', 'install-connection.ps1', 'open-connection.ps1', 'uninstall-connection.ps1', 'start-companion.ps1', 'scripts\test-connection.ps1', 'scripts\test-companion-lifecycle.ps1')) {
    $tokens = $null; $errors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root $file), [ref]$tokens, [ref]$errors)
    Check "syntax $file" (@($errors).Count -eq 0)
}

# --- Exact URI validation ------------------------------------------------------------------
Check 'valid 7816' ((ConvertFrom-FalsifyConnectUri 'falsify://connect?port=7816') -eq 7816)
Check 'valid 1024' ((ConvertFrom-FalsifyConnectUri 'falsify://connect?port=1024') -eq 1024)
Check 'valid 65535' ((ConvertFrom-FalsifyConnectUri 'falsify://connect?port=65535') -eq 65535)
Check 'typed port is int' ((ConvertFrom-FalsifyConnectUri 'falsify://connect?port=7817') -is [int])
# Windows ShellExecute normalizes the empty authority path: Start-Process 'falsify://connect?port=7817'
# delivers argv "falsify://connect/?port=7817". That single empty root slash is the same link and is
# accepted (previously rejected here, which made every real click fail); any other path is not.
Check 'valid root-slash 7817' ((ConvertFrom-FalsifyConnectUri 'falsify://connect/?port=7817') -eq 7817)
Check 'valid root-slash 1024' ((ConvertFrom-FalsifyConnectUri 'falsify://connect/?port=1024') -eq 1024)
Check 'valid root-slash 65535' ((ConvertFrom-FalsifyConnectUri 'falsify://connect/?port=65535') -eq 65535)
Check 'root-slash typed port is int' ((ConvertFrom-FalsifyConnectUri 'falsify://connect/?port=7817') -is [int])
$fullWidthDigits = 'falsify://connect?port=' + [string][char]0xFF17 + [char]0xFF18 + [char]0xFF11 + [char]0xFF16
$malformed = @(
    '', 'falsify://connect', 'falsify://connect?', 'falsify://connect?port=',
    'falsify://connect?port=1023', 'falsify://connect?port=65536', 'falsify://connect?port=99999', 'falsify://connect?port=0',
    'falsify://connect?port=07816', 'falsify://connect?port=+7816', 'falsify://connect?port=-7816', 'falsify://connect?port=7816.0',
    'falsify://connect/x?port=7816', 'falsify://connect?port=7816#frag', 'falsify://connect?port=7816/',
    'falsify://user@connect?port=7816', 'falsify://user:pw@connect?port=7816', 'falsify://connect:80?port=7816',
    'falsify://connect?port=7816&port=7817', 'falsify://connect?port=7816&cmd=calc', 'falsify://connect?origin=https://evil.example&port=7816',
    'falsify://connect?port=7816&model=x', 'falsify://connect?port=7816&token=abc', 'falsify://connect?port=%37816', 'falsify://connect?port%3D7816',
    'falsify://connect?port=7816;calc', 'falsify://connect?port=$(calc)', 'falsify://connect?port=7816"', '"falsify://connect?port=7816"',
    "falsify://connect?port=7816`n", "falsify://connect?port=7816`r`n", 'falsify://connect?port=7816 ', ' falsify://connect?port=7816',
    'falsify://connect?port=7816 -Command calc', 'FALSIFY://connect?port=7816', 'falsify://CONNECT?port=7816', 'falsify://connect?PORT=7816',
    'falsify:connect?port=7816', 'falsify:///connect?port=7816', 'https://connect?port=7816', 'falsify://evil?port=7816', $fullWidthDigits
)
# Root-slash form: only the bare empty root slash is allowed; every other variation still rejects.
$malformed += @(
    'falsify://connect/', 'falsify://connect/?', 'falsify://connect/?port=', 'falsify://connect//?port=7816', 'falsify://connect///?port=7816',
    'falsify://connect/evil?port=7816', 'falsify://connect/./?port=7816', 'falsify://connect/../?port=7816', 'falsify://connect\?port=7816',
    'falsify://connect%2F?port=7816', 'falsify://connect%2f?port=7816', 'falsify://connect/%3Fport=7816', 'falsify://connect/?port=%37816',
    'falsify://connect/?port=1023', 'falsify://connect/?port=65536', 'falsify://connect/?port=0', 'falsify://connect/?port=07816',
    'falsify://connect/?port=7816#frag', 'falsify://connect/?port=7816/', 'falsify://connect/?port=7816&cmd=calc', 'falsify://connect/?port=7816&port=7817',
    'falsify://connect/?origin=x&port=7816', 'falsify://connect/?port=7816&token=abc', 'falsify://user@connect/?port=7816', 'falsify://connect:80/?port=7816',
    'falsify://connect/ ?port=7816', 'falsify://connect /?port=7816', 'falsify://connect/?port=7816 ', "falsify://connect/?port=7816`n",
    'FALSIFY://connect/?port=7816', 'falsify://CONNECT/?port=7816', 'falsify://connect/?PORT=7816', 'falsify://evil/?port=7816',
    'falsify:///?port=7816', 'falsify://connect/?port=7816;calc', 'falsify://connect/?port=7816" -Command "calc'
)
foreach ($uri in $malformed) { Check ('rejects [{0}]' -f ($uri -replace "`r", '\r' -replace "`n", '\n')) (Test-Rejected $uri) }
Check 'rejects null' (Test-Rejected $null)
$nonceA = 'A' * 43; $nonceB = 'B' * 43; $nonceC = 'C' * 43
$pairUri = "falsify://connect?port=7816&challenge=$nonceA&state=$nonceB&proof=$nonceC"
$pairRoot = "falsify://connect/?port=65535&challenge=$nonceA&state=$nonceB&proof=$nonceC"
$parsedPair = ConvertFrom-FalsifyConnectLink $pairUri
Check 'pairing link keeps port and sets pairing' ($parsedPair.Port -eq 7816 -and $parsedPair.Pairing -eq $true -and $parsedPair.Challenge -ceq $nonceA)
Check 'pairing root-slash link' ((ConvertFrom-FalsifyConnectLink $pairRoot).Port -eq 65535)
Check 'port-only parser still rejects nonce links' (Test-Rejected $pairUri)
Check 'pairing link rejects command suffix' (Test-Throws { ConvertFrom-FalsifyConnectLink ($pairUri + '&cmd=calc') })
Check 'pairing link rejects token key' (Test-Throws { ConvertFrom-FalsifyConnectLink "falsify://connect?port=7816&token=abc&challenge=$nonceA&state=$nonceB&proof=$nonceC" })
Check 'approval cancel is not launch' ((Get-FalsifyApprovalDecision -Origin 'https://shinick-han.github.io' -Choice 'no') -eq 'Cancel')
Check 'approval without a choice asks' ((Get-FalsifyApprovalDecision -Origin 'https://shinick-han.github.io' -Choice '') -eq 'Ask')
Check 'approval of another origin is refused' ((Get-FalsifyApprovalDecision -Origin 'https://evil.example' -Choice 'yes') -eq 'Refuse')
Check 'approval yes is explicit' ((Get-FalsifyApprovalDecision -Origin 'https://shinick-han.github.io' -Choice 'yes') -eq 'Approve')

# --- open-connection.ps1 fails closed before launching anything --------------------------
$openScript = Join-Path $root 'open-connection.ps1'
$dryRun = @{ FALSIFY_CONNECT_DRY_RUN = '1' }
foreach ($uri in @('falsify://connect?port=80', 'falsify://connect?port=7816&cmd=calc', 'falsify://connect?port=7816#x', 'falsify://connect?origin=x&port=7816',
        'falsify://connect/evil?port=7816', 'falsify://connect//?port=7816', 'falsify://connect/?port=80', 'falsify://connect/?port=7816&cmd=calc')) {
    $result = Invoke-Child @('-File', $openScript, $uri) $dryRun
    Check "open-connection rejects [$uri]" ($result.ExitCode -ne 0 -and $result.Output -match 'Rejected' -and $result.Output -notmatch 'DRY-RUN')
}
$result = Invoke-Child @('-File', $openScript) $dryRun
Check 'open-connection rejects zero arguments' ($result.ExitCode -ne 0 -and $result.Output -notmatch 'DRY-RUN')
$result = Invoke-Child @('-File', $openScript, 'falsify://connect?port=7816', '-Command', 'calc') $dryRun
Check 'open-connection rejects extra arguments' ($result.ExitCode -ne 0 -and $result.Output -notmatch 'DRY-RUN')
$result = Invoke-Child @('-File', $openScript, 'falsify://connect?port=7817') $dryRun
Check 'open-connection valid link reaches launcher with typed port' ($result.ExitCode -eq 0 -and $result.Output -match 'DRY-RUN start-companion port=7817 ')
$result = Invoke-Child @('-File', $openScript, 'falsify://connect/?port=7817') $dryRun
Check 'open-connection ShellExecute root-slash link reaches launcher with typed port' ($result.ExitCode -eq 0 -and $result.Output -match 'DRY-RUN start-companion port=7817 ')
$result = Invoke-Child @('-File', $openScript, $pairUri) @{ FALSIFY_CONNECT_DRY_RUN = '1'; FALSIFY_CONNECT_APPROVAL = 'no' }
Check 'open-connection user cancel does not launch or print nonces' ($result.ExitCode -ne 0 -and $result.Output -match 'cancelled' -and $result.Output -notmatch [regex]::Escape($nonceA) -and $result.Output -notmatch 'DRY-RUN start-companion')
$result = Invoke-Child @('-File', $openScript, $pairUri) @{ FALSIFY_CONNECT_DRY_RUN = '1'; FALSIFY_CONNECT_APPROVAL = 'yes' }
Check 'open-connection approved pairing dry-run hides nonces' ($result.ExitCode -eq 0 -and $result.Output -match 'DRY-RUN start-companion port=7816 pairing=1 ' -and $result.Output -notmatch [regex]::Escape($nonceA))

# --- Registered command quoting with spaces ----------------------------------------------
$spacedDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('falsify launcher test ' + [guid]::NewGuid().ToString('N'))
$percentDirectory = Join-Path $spacedDirectory 'pct%20dir'
$null = New-Item -ItemType Directory -Path $percentDirectory
try {
    foreach ($file in @('falsify-connection.psm1', 'open-connection.ps1')) { Copy-Item -LiteralPath (Join-Path $root $file) -Destination $spacedDirectory }
    Copy-Item -LiteralPath $openScript -Destination $percentDirectory
    $spacedScript = Join-Path $spacedDirectory 'open-connection.ps1'
    $command = New-FalsifyProtocolCommand -PowerShellPath $powerShell -ScriptPath $spacedScript
    Check 'command exact format' ($command -ceq ('"' + $powerShell + '" -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $spacedScript + '" "%1"'))
    Check 'command has no remote or eval surface' ($command -notmatch '(?i)http|-Command|-EncodedCommand|Invoke-|iex|\$\(')
    Add-Type -Namespace FalsifyTest -Name Native -MemberDefinition '[DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CommandLineToArgvW(string cmd, out int count); [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr p);'
    function Split-CommandLine([string]$Line) {
        $count = 0; $pointer = [FalsifyTest.Native]::CommandLineToArgvW($Line, [ref]$count)
        try { 0..($count - 1) | ForEach-Object { [System.Runtime.InteropServices.Marshal]::PtrToStringUni([System.Runtime.InteropServices.Marshal]::ReadIntPtr($pointer, $_ * [IntPtr]::Size)) } }
        finally { $null = [FalsifyTest.Native]::LocalFree($pointer) }
    }
    $prefix = @($powerShell, '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $spacedScript)
    $argv = @(Split-CommandLine ($command.Replace('%1', 'falsify://connect?port=7816')))
    Check 'argv keeps spaced paths intact' (($argv -join '|') -ceq (($prefix + 'falsify://connect?port=7816') -join '|'))
    $argv = @(Split-CommandLine ($command.Replace('%1', 'falsify://connect/?port=7816')))
    Check 'argv keeps root-slash link as one argument' (($argv -join '|') -ceq (($prefix + 'falsify://connect/?port=7816') -join '|'))
    $argv = @(Split-CommandLine ($command.Replace('%1', 'falsify://connect?port=7816" -Command "calc')))
    Check 'quote injection cannot add PowerShell options before -File' ((($argv[0..($prefix.Length - 1)]) -join '|') -ceq ($prefix -join '|'))
    $result = Invoke-Child @('-File', $spacedScript, 'falsify://connect?port=7816" -Command "calc') $dryRun
    Check 'quote injection becomes rejected script arguments' ($result.ExitCode -ne 0 -and $result.Output -notmatch 'DRY-RUN')
    $result = Invoke-Child @('-File', $spacedScript, 'falsify://connect?port=7818') $dryRun
    Check 'launcher runs from a path with spaces' ($result.ExitCode -eq 0 -and $result.Output -match 'DRY-RUN start-companion port=7818 ')
    $result = Invoke-Child @('-File', $spacedScript, 'falsify://connect/?port=7819') $dryRun
    Check 'launcher accepts root-slash link from a path with spaces' ($result.ExitCode -eq 0 -and $result.Output -match 'DRY-RUN start-companion port=7819 ')
    Check 'rejects percent in script path' (Test-Throws { New-FalsifyProtocolCommand -PowerShellPath $powerShell -ScriptPath (Join-Path $percentDirectory 'open-connection.ps1') })
    Check 'rejects relative script path' (Test-Throws { New-FalsifyProtocolCommand -PowerShellPath $powerShell -ScriptPath '.\open-connection.ps1' })
    Check 'rejects UNC script path' (Test-Throws { New-FalsifyProtocolCommand -PowerShellPath $powerShell -ScriptPath '\\server\share\open-connection.ps1' })
    Check 'rejects other script name' (Test-Throws { New-FalsifyProtocolCommand -PowerShellPath $powerShell -ScriptPath (Join-Path $root 'start-companion.ps1') })
    Check 'rejects non-PowerShell executable' (Test-Throws { New-FalsifyProtocolCommand -PowerShellPath "$env:SystemRoot\System32\cmd.exe" -ScriptPath $openScript })
} finally {
    Remove-Item -LiteralPath (Join-Path $percentDirectory 'open-connection.ps1') -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $percentDirectory -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $spacedDirectory 'falsify-connection.psm1') -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $spacedDirectory 'open-connection.ps1') -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $spacedDirectory -ErrorAction SilentlyContinue
}

# --- Install / uninstall ownership guards (synthetic registry snapshots) -----------------
$constants = Get-FalsifyConnectionConstants
$ownCommand = New-FalsifyProtocolCommand -PowerShellPath $powerShell -ScriptPath $openScript
function New-State([string]$ScriptPath = $openScript, [hashtable]$ExtraRoot = @{}, [hashtable]$ExtraSubkeys = @{}, [string]$Command = '', [bool]$Machine = $false, [string]$Owner = $constants.OwnerMarker) {
    if (-not $Command) { $Command = '"{0}" -NoLogo -NoProfile -ExecutionPolicy Bypass -NoExit -File "{1}" "%1"' -f $powerShell, $ScriptPath }
    $rootValues = @{ '(default)' = $constants.ProtocolDescription; 'URL Protocol' = ''; FalsifyOwner = $Owner; FalsifyScriptPath = $ScriptPath; FalsifyPowerShellPath = $powerShell }
    foreach ($key in $ExtraRoot.Keys) { $rootValues[$key] = $ExtraRoot[$key] }
    $subkeys = @{ 'shell' = @{}; 'shell\open' = @{}; 'shell\open\command' = @{ '(default)' = $Command } }
    foreach ($key in $ExtraSubkeys.Keys) { $subkeys[$key] = $ExtraSubkeys[$key] }
    [pscustomobject]@{ UserKeyExists = $true; MachineKeyExists = $Machine; RootValues = $rootValues; Subkeys = $subkeys }
}
$absent = [pscustomobject]@{ UserKeyExists = $false; MachineKeyExists = $false; RootValues = @{}; Subkeys = @{} }
$machineOnly = [pscustomobject]@{ UserKeyExists = $false; MachineKeyExists = $true; RootValues = @{}; Subkeys = @{} }
$foreign = [pscustomobject]@{ UserKeyExists = $true; MachineKeyExists = $false; RootValues = @{ '(default)' = 'URL:Other App'; 'URL Protocol' = '' }; Subkeys = @{ 'shell' = @{}; 'shell\open' = @{}; 'shell\open\command' = @{ '(default)' = '"C:\Other\other.exe" "%1"' } } }
Check 'install creates when absent' ((Get-FalsifyInstallDecision $absent $ownCommand).Action -eq 'Create')
Check 'install refuses machine-wide owner' ((Get-FalsifyInstallDecision $machineOnly $ownCommand).Action -eq 'Refuse')
Check 'install refuses foreign per-user owner' ((Get-FalsifyInstallDecision $foreign $ownCommand).Action -eq 'Refuse')
Check 'install idempotent for own exact registration' ((Get-FalsifyInstallDecision (New-State -Command $ownCommand) $ownCommand).Action -eq 'AlreadyInstalled')
Check 'legacy NoExit command stays owned and upgrades to hidden exit' ((Test-FalsifyOwnedRegistration (New-State)) -and (Get-FalsifyInstallDecision (New-State) $ownCommand).Action -eq 'Update')
Check 'new protocol command is hidden and exits' ($ownCommand -match '-WindowStyle Hidden -File "' -and $ownCommand -notmatch '-NoExit')
Check 'install re-points own registration from moved checkout' ((Get-FalsifyInstallDecision (New-State -ScriptPath 'C:\Old Place\open-connection.ps1') $ownCommand).Action -eq 'Update')
Check 'install refuses own registration when machine key appears' ((Get-FalsifyInstallDecision (New-State -Machine $true) $ownCommand).Action -eq 'Refuse')
$tampered = @(
    (New-State -Owner 'someone-else'),
    (New-State -ExtraRoot @{ EditFlags = '2' }),
    (New-State -ExtraSubkeys @{ 'shell\runas' = @{} }),
    (New-State -ExtraSubkeys @{ 'DefaultIcon' = @{ '(default)' = 'x' } }),
    (New-State -ExtraSubkeys @{ 'shell\open' = @{ 'DelegateExecute' = '{0}' } }),
    (New-State -Command ('"{0}" -NoProfile -Command "calc" "%1"' -f $powerShell)),
    (New-State -Command ('"{0}" -NoLogo -NoProfile -ExecutionPolicy Bypass -NoExit -File "{1}" "%1"' -f $powerShell, 'C:\Elsewhere\open-connection.ps1'))
)
$index = 0
foreach ($state in $tampered) {
    $index++
    Check "tampered/foreign layout $index is not owned" (-not (Test-FalsifyOwnedRegistration $state))
    Check "install refuses tampered layout $index" ((Get-FalsifyInstallDecision $state $ownCommand).Action -eq 'Refuse')
    Check "uninstall refuses tampered layout $index" ((Get-FalsifyUninstallDecision $state).Action -eq 'Refuse')
}
Check 'uninstall refuses foreign owner' ((Get-FalsifyUninstallDecision $foreign).Action -eq 'Refuse')
Check 'uninstall no-op when absent' ((Get-FalsifyUninstallDecision $absent).Action -eq 'Absent')
Check 'uninstall removes own registration' ((Get-FalsifyUninstallDecision (New-State)).Action -eq 'Remove')
Check 'uninstall removes own registration from moved checkout' ((Get-FalsifyUninstallDecision (New-State -ScriptPath 'C:\Old Place\open-connection.ps1')).Action -eq 'Remove')

# --- Real scripts under -WhatIf leave the registry unchanged -----------------------------
function Get-RegistryFingerprint { (Get-FalsifyProtocolState | ConvertTo-Json -Depth 5 -Compress) }
$before = Get-RegistryFingerprint
$result = Invoke-Child @('-File', (Join-Path $root 'install-connection.ps1'), '-WhatIf')
Check 'install -WhatIf shows fixed command' ($result.Output.Contains('-WindowStyle Hidden -File "' + $openScript + '" "%1"') -and $result.Output -notmatch '-NoExit')
Check 'install -WhatIf leaves registry unchanged' ((Get-RegistryFingerprint) -ceq $before)
$result = Invoke-Child @('-File', (Join-Path $root 'uninstall-connection.ps1'), '-WhatIf')
Check 'uninstall -WhatIf leaves registry unchanged' ((Get-RegistryFingerprint) -ceq $before)

# --- Occupied port: clear error, nothing stopped or set up --------------------------------
$listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), 0
$listener.Start()
try {
    $busyPort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    if ($busyPort -ge 1024) {
        $venvBefore = Test-Path -LiteralPath (Join-Path $root '.venv')
        Check 'occupied port detected' (-not (Test-FalsifyPortAvailable -Port $busyPort))
        $result = Invoke-Child @('-File', (Join-Path $root 'start-companion.ps1'), '-Port', [string]$busyPort)
        Check 'start-companion stops on occupied port with alternate-port advice' ($result.ExitCode -ne 0 -and $result.Output -match 'already in use' -and $result.Output -match 'connect\?port=')
        Check 'occupied port: no setup or broker ran' ($result.Output -notmatch 'Setup:|Pairing token|Falsify local:' -and (Test-Path -LiteralPath (Join-Path $root '.venv')) -eq $venvBefore)
        Check 'occupied port: existing listener untouched' (-not (Test-FalsifyPortAvailable -Port $busyPort))
    } else { Check 'ephemeral test port above 1023' $false }
} finally { $listener.Stop() }

# --- Static guards against persistence, broad deletes and remote commands -----------------
$sources = @{}
foreach ($file in @('falsify-connection.psm1', 'companion-lifecycle.psm1', 'install-connection.ps1', 'open-connection.ps1', 'uninstall-connection.ps1', 'start-companion.ps1')) { $sources[$file] = Get-Content -LiteralPath (Join-Path $root $file) -Raw }
$all = ($sources.Values -join "`n")
$allCode = $all -replace '(?m)^\s*#.*$', ''
# The one allowed Start-Process is splatted. Foreground stays in this window; background is hidden and still this same call.
$brokerLaunch = '$broker = Start-Process @brokerStart'
Check 'only Start-Process is the broker' (([regex]::Matches($allCode, 'Start-Process')).Count -eq 1 -and $sources['start-companion.ps1'].Contains($brokerLaunch))
Check 'foreground stays in the connection window' ($sources['start-companion.ps1'].Contains('$brokerStart.NoNewWindow = $true'))
Check 'background is hidden only for approved pairing' ($sources['start-companion.ps1'].Contains("if (`$Background) { `$brokerStart.WindowStyle = 'Hidden' }"))
Check 'no process termination' ($all -notmatch '(?i)Stop-Process|taskkill|\.Kill\(')
Check 'no recursive registry delete' ($all -notmatch '(?i)Remove-Item[^\r\n]*-Recurse|Remove-ItemProperty|reg(\.exe)?\s+delete')
Check 'no machine-wide writes' ($all -notmatch '(?i)(New-Item|Set-ItemProperty|Remove-Item)[^\r\n]*HKLM')
Check 'no startup, task or service persistence' ($allCode.Replace($brokerLaunch, '') -notmatch '(?i)CurrentVersion\\Run|Register-ScheduledTask|schtasks|New-Service|Start-Process')
Check 'no remote download or eval' ($all -notmatch '(?i)Invoke-WebRequest|Invoke-RestMethod|DownloadString|Invoke-Expression|\biex\b|-EncodedCommand')
Check 'no browser-policy suppression' ($all -notmatch '(?i)AutoLaunchProtocolsFromOrigins|ExternalProtocolDialog|ExcludedSchemes')
Check 'open-connection passes only the typed port' ($sources['open-connection.ps1'] -match '& \$launcher -Port \$port\r?\n' -and $sources['open-connection.ps1'] -notmatch '(?i)web-origin|--model|codex|claude')
Check 'web origin fixed' ($sources['falsify-connection.psm1'] -match "WebOrigin = 'https://shinick-han\.github\.io'" -and $sources['start-companion.ps1'] -match '\(Get-FalsifyConnectionConstants\)\.WebOrigin')
Check 'no automatic CLI install or sign-in' ($sources['start-companion.ps1'] -notmatch '(?i)npm\s+(i|install)|winget|&\s*codex|&\s*claude|login\s*$')

Write-Host ('{0} checks, {1} failed ({2} {3})' -f $script:checks, $script:failures, $PSVersionTable.PSEdition, $PSVersionTable.PSVersion)
if ($script:failures -ne 0 -or $script:checks -eq 0) { exit 1 }
# Expected-failure children (rejected URIs, occupied port) leave $LASTEXITCODE nonzero; hosts such as the
# GitHub Actions pwsh wrapper propagate it, so success must be explicit once every assertion has passed.
exit 0
