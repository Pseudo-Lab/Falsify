# Same-checkout companion lifecycle helpers for start-companion.ps1.
# Identity comes from the OS listener table and the owning process's exact argv before any HTTP
# request; HTTP is loopback-only, bounded, without redirects or proxies. Nothing here stops,
# kills or signals a process: an idle companion is only ever asked to restart through its own API.
Set-StrictMode -Version 2.0

$script:LifecycleSchema = 'falsify-companion-lifecycle/1'
$script:CompanionOptions = @('--port', '--web-origin', '--token-display', '--pairing-dir', '--pdf-editor-root', '--pdf-editor-manifest', '--pdf-editor-source-root', '--pdf-editor-node')
$script:DescriptorKeys = @('schema', 'pid', 'instanceId', 'serverPath', 'webOrigin', 'busy')

if (-not ('FalsifyLifecycle.Native' -as [type])) {
    Add-Type -Namespace FalsifyLifecycle -Name Native -MemberDefinition '[DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CommandLineToArgvW(string cmd, out int count); [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr p);'
}
Add-Type -AssemblyName System.Net.Http
Import-Module (Join-Path $PSScriptRoot 'falsify-connection.psm1')

function Split-FalsifyCommandLine {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$CommandLine)
    if ($CommandLine -eq '') { return ,@() }
    $count = 0
    $pointer = [FalsifyLifecycle.Native]::CommandLineToArgvW($CommandLine, [ref]$count)
    if ($pointer -eq [IntPtr]::Zero) { throw 'Could not parse a process command line.' }
    try {
        $argv = New-Object string[] $count
        for ($i = 0; $i -lt $count; $i++) {
            $argv[$i] = [System.Runtime.InteropServices.Marshal]::PtrToStringUni([System.Runtime.InteropServices.Marshal]::ReadIntPtr($pointer, $i * [IntPtr]::Size))
        }
        return ,$argv
    } finally { $null = [FalsifyLifecycle.Native]::LocalFree($pointer) }
}

# One argument quoted for the MSVCRT/CommandLineToArgvW rules (Start-Process passes the string as-is on PS5 and PS7).
function ConvertTo-FalsifyNativeArgument {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
    if ($Value -ne '' -and $Value -notmatch '[\s"]') { return $Value }
    $builder = New-Object System.Text.StringBuilder
    $null = $builder.Append('"')
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') { $backslashes++; continue }
        if ($character -eq '"') { $null = $builder.Append('\', 2 * $backslashes + 1).Append('"') }
        else { if ($backslashes) { $null = $builder.Append('\', $backslashes) }; $null = $builder.Append($character) }
        $backslashes = 0
    }
    if ($backslashes) { $null = $builder.Append('\', 2 * $backslashes) }
    return $builder.Append('"').ToString()
}

function Join-FalsifyNativeArguments {
    param([Parameter(Mandatory)][AllowEmptyString()][string[]]$Arguments)
    return (@($Arguments | ForEach-Object { ConvertTo-FalsifyNativeArgument -Value $_ }) -join ' ')
}

function New-FalsifyArgvResult([bool]$Owned, [string]$Reason, [hashtable]$Options = @{}) {
    [pscustomobject]@{
        Owned = $Owned; Reason = $Reason
        WebOrigin = $Options['--web-origin']; EditorRoot = $Options['--pdf-editor-root']; EditorManifest = $Options['--pdf-editor-manifest']
    }
}

# Exact argv of this checkout's companion: python[w].exe [-u] <absolute server.py> --port <Port> [known options once each].
# The script may use either slash and is canonicalized with GetFullPath. Other interpreter flags (-c, -m, -X ...),
# relative or other scripts, unknown/abbreviated/= options and duplicates fail closed.
function Test-FalsifyCompanionArgv {
    param([AllowNull()][string[]]$Argv, [AllowNull()][AllowEmptyString()][string]$ExecutablePath,
          [Parameter(Mandatory)][string]$ServerPath, [Parameter(Mandatory)][int]$Port)
    if ([string]::IsNullOrEmpty($ExecutablePath) -or $ExecutablePath -notmatch '\A[A-Za-z]:\\') { return New-FalsifyArgvResult $false 'executable path unavailable' }
    if ([System.IO.Path]::GetFileName($ExecutablePath) -notin @('python.exe', 'pythonw.exe')) { return New-FalsifyArgvResult $false 'listener is not a Python interpreter' }
    if ($null -eq $Argv) { return New-FalsifyArgvResult $false 'unexpected command line' }
    $scriptIndex = if ($Argv.Count -gt 1 -and $Argv[1] -ceq '-u') { 2 } else { 1 }
    if ($Argv.Count -lt $scriptIndex + 3) { return New-FalsifyArgvResult $false 'unexpected command line' }
    $script = $Argv[$scriptIndex]
    if ($script -notmatch '\A[A-Za-z]:[\\/]') { return New-FalsifyArgvResult $false 'script argument is not an absolute local path' }
    try { $resolved = [System.IO.Path]::GetFullPath($script) } catch { return New-FalsifyArgvResult $false 'script argument is not a valid path' }
    if (-not $resolved.Equals($ServerPath, [System.StringComparison]::OrdinalIgnoreCase)) { return New-FalsifyArgvResult $false 'a different server script' }
    $options = @{}
    for ($i = $scriptIndex + 1; $i -lt $Argv.Count; $i += 2) {
        $name = $Argv[$i]
        if ($name -cnotin $script:CompanionOptions) { return New-FalsifyArgvResult $false 'unrecognized companion option' }
        if ($options.ContainsKey($name)) { return New-FalsifyArgvResult $false 'repeated companion option' }
        if ($i + 1 -ge $Argv.Count -or $Argv[$i + 1].StartsWith('-')) { return New-FalsifyArgvResult $false 'companion option without value' }
        $options[$name] = $Argv[$i + 1]
    }
    if ($options['--port'] -cne [string]$Port) { return New-FalsifyArgvResult $false 'companion serves a different port' }
    return New-FalsifyArgvResult $true '' $options
}

# Pure: classify the port from listener rows (LocalAddress, OwningProcess) and the owning process
# (ProcessId, ParentProcessId, ExecutablePath, CommandLine, CreationDate).
function Resolve-FalsifyPortOccupant {
    param([Parameter(Mandatory)][int]$Port, [Parameter(Mandatory)][string]$ServerPath, [AllowNull()][object[]]$Listeners, [AllowNull()]$Process)
    $foreign = { param($reason) [pscustomobject]@{ Kind = 'Foreign'; Reason = $reason; Pid = $null; ParentPid = $null; CreationDate = $null; WebOrigin = $null; EditorRoot = $null; EditorManifest = $null } }
    $rows = @($Listeners | Where-Object { $null -ne $_ })
    if ($rows.Count -eq 0) { return & $foreign 'listener owner unavailable' }
    $owners = @($rows | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique)
    if ($owners.Count -ne 1) { return & $foreign 'several processes listen on it' }
    if (@($rows | Where-Object { [string]$_.LocalAddress -ne '127.0.0.1' }).Count -ne 0) { return & $foreign 'it listens beyond 127.0.0.1' }
    if ($null -eq $Process -or [int]$Process.ProcessId -ne $owners[0]) { return & $foreign 'listening process could not be inspected' }
    if ([string]::IsNullOrEmpty([string]$Process.CommandLine)) { return & $foreign 'listening process command line is unavailable' }
    try { $argv = Split-FalsifyCommandLine -CommandLine ([string]$Process.CommandLine) } catch { return & $foreign 'unparseable command line' }
    $identity = Test-FalsifyCompanionArgv -Argv $argv -ExecutablePath ([string]$Process.ExecutablePath) -ServerPath $ServerPath -Port $Port
    if (-not $identity.Owned) { return & $foreign $identity.Reason }
    [pscustomobject]@{
        Kind = 'Owned'; Reason = ''; Pid = $owners[0]; ParentPid = $Process.ParentProcessId; CreationDate = $Process.CreationDate
        WebOrigin = $identity.WebOrigin; EditorRoot = $identity.EditorRoot; EditorManifest = $identity.EditorManifest
    }
}

# Read-only OS lookup. Never connects to, binds or stops anything.
function Get-FalsifyPortOccupant {
    param([Parameter(Mandatory)][int]$Port, [Parameter(Mandatory)][string]$ServerPath)
    if (Test-FalsifyPortAvailable -Port $Port) {
        return [pscustomobject]@{ Kind = 'Free'; Reason = ''; Pid = $null; ParentPid = $null; CreationDate = $null; WebOrigin = $null; EditorRoot = $null; EditorManifest = $null }
    }
    $listeners = @()
    try { $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop) } catch { $listeners = @() }
    $process = $null
    $owners = @($listeners | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique)
    if ($owners.Count -eq 1) {
        try { $process = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = {0}' -f $owners[0]) -ErrorAction Stop | Select-Object -First 1 } catch { $process = $null }
    }
    return Resolve-FalsifyPortOccupant -Port $Port -ServerPath $ServerPath -Listeners $listeners -Process $process
}

function Test-FalsifySameOccupant {
    param([Parameter(Mandatory)]$Before, [Parameter(Mandatory)]$After)
    return ($Before.Kind -eq 'Owned' -and $After.Kind -eq 'Owned' -and $Before.Pid -eq $After.Pid -and
        [string]$Before.CreationDate -eq [string]$After.CreationDate -and [string]$Before.WebOrigin -ceq [string]$After.WebOrigin)
}

function New-FalsifyLoopbackHttpClient {
    param([ValidateRange(1, 60)][int]$TimeoutSeconds = 5)
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $handler.UseProxy = $false
    $handler.Proxy = $null
    $handler.UseCookies = $false
    $handler.UseDefaultCredentials = $false
    $client = New-Object System.Net.Http.HttpClient -ArgumentList $handler, $true
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
    $client.MaxResponseContentBufferSize = 65536
    $client.DefaultRequestHeaders.ExpectContinue = $false
    return $client
}

# Returns Status (0 on transport failure) and parsed Json (or $null). Errors never echo headers or bodies.
function Invoke-FalsifyLoopbackRequest {
    param([Parameter(Mandatory)][int]$Port, [ValidateSet('GET', 'POST')][string]$Method = 'GET', [Parameter(Mandatory)][string]$Path,
          [hashtable]$Headers = @{}, [AllowNull()][string]$JsonBody = $null, [int]$TimeoutSeconds = 5)
    $client = New-FalsifyLoopbackHttpClient -TimeoutSeconds $TimeoutSeconds
    try {
        $request = New-Object System.Net.Http.HttpRequestMessage ([System.Net.Http.HttpMethod]::new($Method)), ('http://127.0.0.1:{0}{1}' -f $Port, $Path)
        foreach ($name in $Headers.Keys) { $null = $request.Headers.TryAddWithoutValidation($name, [string]$Headers[$name]) }
        if ($Method -eq 'POST' -and $null -ne $JsonBody) {
            $request.Content = New-Object System.Net.Http.ByteArrayContent (, [System.Text.Encoding]::UTF8.GetBytes($JsonBody))
            $request.Content.Headers.ContentType = New-Object System.Net.Http.Headers.MediaTypeHeaderValue 'application/json'
        }
        try {
            $response = $client.SendAsync($request).GetAwaiter().GetResult()
            $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        } catch { return [pscustomobject]@{ Status = 0; Json = $null } }
        $json = $null
        try { if ($text) { $json = $text | ConvertFrom-Json -ErrorAction Stop } } catch { $json = $null }
        return [pscustomobject]@{ Status = [int]$response.StatusCode; Json = $json }
    } finally { $client.Dispose() }
}

function Get-FalsifyJsonValue($Json, [string]$Name) {
    if ($null -eq $Json -or $Json -isnot [System.Management.Automation.PSCustomObject]) { return $null }
    $property = $Json.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Test-FalsifyTokenShape([AllowNull()]$Token) {
    return ($Token -is [string] -and $Token -match '\A[A-Za-z0-9_-]{16,256}\z')
}

# Same-origin bootstrap of the pairing token from an already OS-verified companion.
function Get-FalsifyCompanionToken {
    param([Parameter(Mandatory)][int]$Port)
    $result = Invoke-FalsifyLoopbackRequest -Port $Port -Path '/api/session' -Headers @{ 'Sec-Fetch-Site' = 'same-origin' }
    $token = Get-FalsifyJsonValue $result.Json 'token'
    if ($result.Status -ne 200 -or -not (Test-FalsifyTokenShape $token)) { return $null }
    return $token
}

function Get-FalsifyLauncherHeaders([string]$Token) { @{ Authorization = 'Bearer ' + $Token; 'X-Falsify-Launcher' = '1' } }

function Get-FalsifyCompanionDescriptor {
    param([Parameter(Mandatory)][int]$Port, [Parameter(Mandatory)][string]$Token)
    return Invoke-FalsifyLoopbackRequest -Port $Port -Path '/api/launcher/instance' -Headers (Get-FalsifyLauncherHeaders $Token)
}

# Pure: $null when the descriptor exactly matches the OS-verified occupant, else the reason.
function Test-FalsifyCompanionDescriptor {
    param([AllowNull()]$Json, [Parameter(Mandatory)]$Occupant, [Parameter(Mandatory)][string]$ServerPath)
    if ($null -eq $Json -or $Json -isnot [System.Management.Automation.PSCustomObject]) { return 'descriptor is not a JSON object' }
    $names = @($Json.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names.Count -ne $script:DescriptorKeys.Count -or @($names | Where-Object { $_ -cnotin $script:DescriptorKeys }).Count -ne 0) { return 'descriptor fields differ' }
    if ($Json.schema -cne $script:LifecycleSchema) { return 'descriptor schema differs' }
    if (-not ($Json.pid -is [int] -or $Json.pid -is [long]) -or [long]$Json.pid -ne [long]$Occupant.Pid) { return 'descriptor pid differs from the listening process' }
    if ($Json.serverPath -isnot [string] -or -not $Json.serverPath.Equals($ServerPath, [System.StringComparison]::OrdinalIgnoreCase)) { return 'descriptor server path differs' }
    if ($Json.instanceId -isnot [string] -or $Json.instanceId -notmatch '\A[A-Za-z0-9_-]{8,128}\z') { return 'descriptor instance id is invalid' }
    if ($null -ne $Json.webOrigin -and $Json.webOrigin -isnot [string]) { return 'descriptor web origin is invalid' }
    if ([string]$Json.webOrigin -cne [string]$Occupant.WebOrigin) { return 'descriptor web origin differs from the process arguments' }
    if ($Json.busy -isnot [bool]) { return 'descriptor busy flag is invalid' }
    return $null
}

# Legacy companions predate /api/launcher/*; reuse them only with an authenticated, working capabilities answer.
function Test-FalsifyLegacyCompanion {
    param([Parameter(Mandatory)][int]$Port, [Parameter(Mandatory)][string]$Token)
    $result = Invoke-FalsifyLoopbackRequest -Port $Port -Path '/api/capabilities' -Headers @{ Authorization = 'Bearer ' + $Token; 'Sec-Fetch-Site' = 'same-origin' }
    return ($result.Status -eq 200 -and (Get-FalsifyJsonValue $result.Json 'red') -eq $true -and (Get-FalsifyJsonValue $result.Json 'blue') -eq $true)
}

# Posts the one-time nonces with the launcher header. The process token stays in the header and is not returned.
function Register-FalsifyBrowserPairing {
    param([Parameter(Mandatory)][int]$Port, [Parameter(Mandatory)][string]$Token, [Parameter(Mandatory)][string]$Challenge,
          [Parameter(Mandatory)][string]$State, [Parameter(Mandatory)][string]$Proof)
    if ($Challenge -notmatch '\A[A-Za-z0-9_-]{43}\z' -or $State -notmatch '\A[A-Za-z0-9_-]{43}\z' -or $Proof -notmatch '\A[A-Za-z0-9_-]{43}\z') { return $false }
    $body = '{"schema":"falsify.pair-register.v1","challenge":"' + $Challenge + '","state":"' + $State + '","proof":"' + $Proof + '"}'
    $result = Invoke-FalsifyLoopbackRequest -Port $Port -Method POST -Path '/api/pair/register' -Headers (Get-FalsifyLauncherHeaders $Token) -JsonBody $body
    return ($result.Status -eq 200 -and (Get-FalsifyJsonValue $result.Json 'registered') -eq $true)
}

function Invoke-FalsifyCompanionRestart {
    param([Parameter(Mandatory)][int]$Port, [Parameter(Mandatory)][string]$Token, [Parameter(Mandatory)][string]$InstanceId)
    $body = [ordered]@{ schema = $script:LifecycleSchema; instanceId = $InstanceId } | ConvertTo-Json -Compress
    $result = Invoke-FalsifyLoopbackRequest -Port $Port -Method POST -Path '/api/launcher/restart' -Headers (Get-FalsifyLauncherHeaders $Token) -JsonBody $body
    return Get-FalsifyRestartOutcome -Status $result.Status -Json $result.Json
}

# Pure: Restarting only for 200 {restarting:true}; Busy only for 409 companion_busy; anything else Failed.
function Get-FalsifyRestartOutcome {
    param([int]$Status, [AllowNull()]$Json)
    if ($Status -eq 200 -and (Get-FalsifyJsonValue $Json 'restarting') -eq $true) { return 'Restarting' }
    if ($Status -eq 409 -and (Get-FalsifyJsonValue $Json 'error') -ceq 'companion_busy') { return 'Busy' }
    return 'Failed'
}

# Pure: $null when a reused companion serves the requested configuration, else what differs.
function Get-FalsifyReuseMismatch {
    param([AllowNull()][string]$ExistingWebOrigin, [AllowNull()][string]$RequestedWebOrigin, [Parameter(Mandatory)]$Occupant, [AllowNull()]$RequestedEditor)
    if ([string]$ExistingWebOrigin -cne [string]$RequestedWebOrigin) {
        $existing = if ($ExistingWebOrigin) { "website pairing with $ExistingWebOrigin" } else { 'local-only (-LocalOnly)' }
        $wanted = if ($RequestedWebOrigin) { "website pairing with $RequestedWebOrigin" } else { 'local-only (-LocalOnly)' }
        return "it runs $existing but $wanted was requested"
    }
    $existingEditor = [bool]$Occupant.EditorRoot
    if ($existingEditor -ne [bool]$RequestedEditor) { return 'its PDF editor configuration differs from the requested one' }
    if ($existingEditor -and (-not ([string]$Occupant.EditorRoot).Equals([string]$RequestedEditor.Root, [System.StringComparison]::OrdinalIgnoreCase) -or
            -not ([string]$Occupant.EditorManifest).Equals([string]$RequestedEditor.Manifest, [System.StringComparison]::OrdinalIgnoreCase))) {
        return 'its PDF editor configuration differs from the requested one'
    }
    return $null
}

function Get-FalsifyLauncherMutexName {
    param([Parameter(Mandatory)][int]$Port)
    return ('Local\FalsifyCompanionLauncher-{0}-{1}' -f [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value, $Port)
}

# Per-user, per-port launcher transaction lock with a finite wait. Returns the held mutex.
function Enter-FalsifyLauncherLock {
    param([Parameter(Mandatory)][int]$Port, [ValidateRange(1, 600000)][int]$TimeoutMilliseconds = 90000)
    $mutex = New-Object System.Threading.Mutex -ArgumentList $false, (Get-FalsifyLauncherMutexName -Port $Port)
    $acquired = $false
    try { $acquired = $mutex.WaitOne($TimeoutMilliseconds) }
    catch [System.Threading.AbandonedMutexException] { $acquired = $true }
    catch { $mutex.Dispose(); throw }
    if (-not $acquired) {
        $mutex.Dispose()
        throw ("Another Falsify launch for port {0} is still in progress (waited {1} s). Nothing was stopped or started; let it finish, then try again." -f $Port, [int]($TimeoutMilliseconds / 1000))
    }
    return $mutex
}

function Exit-FalsifyLauncherLock {
    param([AllowNull()]$Mutex)
    if ($null -eq $Mutex) { return }
    try { $Mutex.ReleaseMutex() } catch { } finally { $Mutex.Dispose() }
}

function Wait-FalsifyPortReleased {
    param([Parameter(Mandatory)][int]$Port, [int]$TimeoutSeconds = 30)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-FalsifyPortAvailable -Port $Port) { return $true }
        Start-Sleep -Milliseconds 200
    }
    return (Test-FalsifyPortAvailable -Port $Port)
}

# Ready once this checkout's companion listens on the port and is the started process or its direct
# child (a venv python.exe redirector runs the base interpreter as a child). Ready/Exited/Timeout.
function Wait-FalsifyBrokerReady {
    param([Parameter(Mandatory)][System.Diagnostics.Process]$Process, [Parameter(Mandatory)][int]$Port,
          [Parameter(Mandatory)][string]$ServerPath, [int]$TimeoutSeconds = 120)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($Process.HasExited) { return 'Exited' }
        $occupant = Get-FalsifyPortOccupant -Port $Port -ServerPath $ServerPath
        if ($occupant.Kind -eq 'Owned' -and ($occupant.Pid -eq $Process.Id -or $occupant.ParentPid -eq $Process.Id)) { return 'Ready' }
        Start-Sleep -Milliseconds 250
    }
    if ($Process.HasExited) { return 'Exited' }
    return 'Timeout'
}

Export-ModuleMember -Function Split-FalsifyCommandLine, ConvertTo-FalsifyNativeArgument, Join-FalsifyNativeArguments, Test-FalsifyCompanionArgv,
    Resolve-FalsifyPortOccupant, Get-FalsifyPortOccupant, Test-FalsifySameOccupant, New-FalsifyLoopbackHttpClient, Invoke-FalsifyLoopbackRequest,
    Get-FalsifyCompanionToken, Get-FalsifyCompanionDescriptor, Test-FalsifyCompanionDescriptor, Test-FalsifyLegacyCompanion,
    Invoke-FalsifyCompanionRestart, Register-FalsifyBrowserPairing, Get-FalsifyRestartOutcome, Get-FalsifyReuseMismatch, Get-FalsifyLauncherMutexName,
    Enter-FalsifyLauncherLock, Exit-FalsifyLauncherLock, Wait-FalsifyPortReleased, Wait-FalsifyBrokerReady
