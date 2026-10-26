<#
Lifecycle tests for start-companion.ps1 and companion-lifecycle.psm1. Pure helpers run on synthetic inputs;
real tests run throwaway stub companions on fresh ephemeral loopback ports from a temporary checkout copy.
They never use an existing port, never stop a process they did not start (stubs leave through their own
test-only route or stdin EOF), never call a model and never contact an external network.
Run: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-companion-lifecycle.ps1
(also under pwsh). Exit code 0 means every check passed.
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Import-Module (Join-Path $root 'falsify-connection.psm1') -Force
Import-Module (Join-Path $root 'companion-lifecycle.psm1') -Force
$powerShell = Resolve-FalsifyPowerShellPath
$script:failures = 0
$script:checks = 0

function Check([string]$Name, [bool]$Condition) {
    $script:checks++
    if ($Condition) { Write-Host "ok   $Name" } else { $script:failures++; Write-Host "FAIL $Name" }
}

function Test-Throws([scriptblock]$Block) {
    try { $null = & $Block; return $false } catch { return $true }
}

# --- Exact argv identity (CommandLineToArgvW, never substrings) ---------------------------------
$server = 'D:\Repo Tree\falsify\app\local\server.py'
$py = 'D:\Python312\python.exe'
function Owned([string]$Line, [string]$Exe = $py, [int]$Port = 7816) {
    (Test-FalsifyCompanionArgv -Argv (Split-FalsifyCommandLine $Line) -ExecutablePath $Exe -ServerPath $server -Port $Port).Owned
}
Check 'argv owned: backslash script' (Owned '"D:\Python312\python.exe" "D:\Repo Tree\falsify\app\local\server.py" --port 7816')
Check 'argv owned: -u forward-slash script (existing-session form)' (Owned 'python.exe -u "D:/Repo Tree/falsify/app/local/server.py" --port 7816')
Check 'argv owned: mixed slashes, lowercase drive, web origin' (Owned 'python -u "d:\Repo Tree/falsify\app/local/server.py" --port 7816 --web-origin https://shinick-han.github.io')
Check 'argv owned: pythonw with editor options' (Owned 'pythonw "D:\Repo Tree\falsify\app\local\server.py" --port 7816 --pdf-editor-root D:\ed --pdf-editor-manifest D:\ed\candidate-manifest.json' 'D:\Python312\pythonw.exe')
Check 'argv owned: dot segments canonicalize to the same file' (Owned 'python "D:\Repo Tree\falsify\app\x\..\local\server.py" --port 7816')
$identity = Test-FalsifyCompanionArgv -Argv (Split-FalsifyCommandLine 'python -u "D:/Repo Tree/falsify/app/local/server.py" --port 7816 --web-origin https://shinick-han.github.io') -ExecutablePath $py -ServerPath $server -Port 7816
Check 'argv reports web origin and no editor' ($identity.WebOrigin -ceq 'https://shinick-han.github.io' -and $null -eq $identity.EditorRoot)
$serverArg = '"D:\Repo Tree\falsify\app\local\server.py"'
$rejectedLines = [ordered]@{
    '-c code' = "python -c `"import server`" $serverArg --port 7816"
    '-m module' = 'python -m server --port 7816 x'
    '-X flag' = "python -X utf8 $serverArg --port 7816"
    'repeated -u' = "python -u -u $serverArg --port 7816"
    '-u after the script' = "python $serverArg -u --port 7816"
    'relative script' = 'python app\local\server.py --port 7816'
    'drive-relative script' = 'python "D:Repo Tree\falsify\app\local\server.py" --port 7816'
    'UNC script' = 'python \\server\share\app\local\server.py --port 7816'
    'other checkout' = 'python "D:\Other\falsify\app\local\server.py" --port 7816'
    'dot segments resolving elsewhere' = 'python "D:\Repo Tree\falsify\app\local\..\server.py" --port 7816'
    'server path only as a later argument' = "python D:\evil.py $serverArg --port 7816"
    'wrong port' = "python $serverArg --port 7817"
    'leading-zero port' = "python $serverArg --port 07816"
    'missing port' = "python $serverArg --web-origin https://shinick-han.github.io"
    'equals-form option' = "python $serverArg --port=7816 --web-origin https://shinick-han.github.io"
    'abbreviated option' = "python $serverArg --po 7816"
    'duplicate port' = "python $serverArg --port 7816 --port 7816"
    'unknown option' = "python $serverArg --port 7816 --debug 1"
    'option without value' = "python $serverArg --port 7816 --web-origin"
    'option value that is a flag' = "python $serverArg --port 7816 --web-origin --port"
}
foreach ($name in $rejectedLines.Keys) { Check "argv rejects $name" (-not (Owned $rejectedLines[$name])) }
Check 'argv rejects a non-Python executable' (-not (Owned "node $serverArg --port 7816" 'D:\nodejs\node.exe'))
Check 'argv rejects an unavailable executable path' (-not (Owned "python $serverArg --port 7816" ''))
Check 'argv rejects a relative executable path' (-not (Owned "python $serverArg --port 7816" 'python.exe'))
Check 'argv rejects the wrong target port' (-not (Owned "python $serverArg --port 7816" $py 7817))

# --- OS occupant classification (synthetic listener rows and processes) ------------------------
$ownedProcess = [pscustomobject]@{ ProcessId = 4242; ParentProcessId = 4000; ExecutablePath = $py; CommandLine = 'python -u "D:/Repo Tree/falsify/app/local/server.py" --port 7816'; CreationDate = [datetime]'2026-10-12' }
function Row([string]$Address = '127.0.0.1', [int]$OwnerPid = 4242) { [pscustomobject]@{ LocalAddress = $Address; OwningProcess = $OwnerPid } }
function Kind([object[]]$Rows, $Process) { (Resolve-FalsifyPortOccupant -Port 7816 -ServerPath $server -Listeners $Rows -Process $Process).Kind }
$occupant = Resolve-FalsifyPortOccupant -Port 7816 -ServerPath $server -Listeners @(Row) -Process $ownedProcess
Check 'occupant owned with pid, parent and no web origin' ($occupant.Kind -eq 'Owned' -and $occupant.Pid -eq 4242 -and $occupant.ParentPid -eq 4000 -and $null -eq $occupant.WebOrigin)
Check 'occupant foreign: owner rows unavailable' ((Kind @() $ownedProcess) -eq 'Foreign')
Check 'occupant foreign: two owning processes' ((Kind @((Row), (Row '127.0.0.1' 4243)) $ownedProcess) -eq 'Foreign')
Check 'occupant foreign: wildcard listener' ((Kind @(Row '0.0.0.0') $ownedProcess) -eq 'Foreign')
Check 'occupant foreign: extra IPv6 loopback listener' ((Kind @((Row), (Row '::1')) $ownedProcess) -eq 'Foreign')
Check 'occupant foreign: process not inspectable' ((Kind @(Row) $null) -eq 'Foreign')
Check 'occupant foreign: process id differs from listener' ((Kind @(Row '127.0.0.1' 4243) $ownedProcess) -eq 'Foreign')
Check 'occupant foreign: command line unavailable' ((Kind @(Row) ([pscustomobject]@{ ProcessId = 4242; ParentProcessId = 1; ExecutablePath = $py; CommandLine = $null; CreationDate = $null })) -eq 'Foreign')
Check 'occupant foreign: spoofed command line' ((Kind @(Row) ([pscustomobject]@{ ProcessId = 4242; ParentProcessId = 1; ExecutablePath = $py; CommandLine = "python D:\evil.py $serverArg --port 7816"; CreationDate = $null })) -eq 'Foreign')
$later = Resolve-FalsifyPortOccupant -Port 7816 -ServerPath $server -Listeners @(Row) -Process ([pscustomobject]@{ ProcessId = 4242; ParentProcessId = 4000; ExecutablePath = $py; CommandLine = $ownedProcess.CommandLine; CreationDate = [datetime]'2026-10-13' })
Check 'same-occupant recheck: identical' (Test-FalsifySameOccupant $occupant $occupant)
Check 'same-occupant recheck: reused pid with new creation time differs' (-not (Test-FalsifySameOccupant $occupant $later))

# --- Lifecycle descriptor validation -----------------------------------------------------------
function Descriptor([hashtable]$Override = @{}, [string[]]$Drop = @()) {
    $value = [ordered]@{ schema = 'falsify-companion-lifecycle/1'; pid = 4242; instanceId = 'abcdef0123456789'; serverPath = $server; webOrigin = $null; busy = $false }
    foreach ($key in $Override.Keys) { $value[$key] = $Override[$key] }
    foreach ($key in $Drop) { $value.Remove($key) }
    return ($value | ConvertTo-Json -Compress | ConvertFrom-Json)
}
function DescriptorOk($Json) { $null -eq (Test-FalsifyCompanionDescriptor -Json $Json -Occupant $occupant -ServerPath $server) }
Check 'descriptor valid' (DescriptorOk (Descriptor))
Check 'descriptor rejects extra field' (-not (DescriptorOk (Descriptor @{ token = 'x' })))
Check 'descriptor rejects missing busy' (-not (DescriptorOk (Descriptor @{} @('busy'))))
Check 'descriptor rejects other pid' (-not (DescriptorOk (Descriptor @{ pid = 4243 })))
Check 'descriptor rejects string pid' (-not (DescriptorOk (Descriptor @{ pid = '4242' })))
Check 'descriptor rejects other server path' (-not (DescriptorOk (Descriptor @{ serverPath = 'D:\Other\app\local\server.py' })))
Check 'descriptor rejects other schema' (-not (DescriptorOk (Descriptor @{ schema = 'falsify-companion-lifecycle/2' })))
Check 'descriptor rejects web origin not in argv' (-not (DescriptorOk (Descriptor @{ webOrigin = 'https://shinick-han.github.io' })))
Check 'descriptor rejects non-boolean busy' (-not (DescriptorOk (Descriptor @{ busy = 'false' })))
Check 'descriptor rejects malformed instance id' (-not (DescriptorOk (Descriptor @{ instanceId = 'a b' })))
Check 'descriptor rejects non-object' (-not (DescriptorOk 'descriptor'))

# --- Restart outcome and reuse configuration ---------------------------------------------------
function Outcome([int]$Status, [string]$Body) { Get-FalsifyRestartOutcome -Status $Status -Json $(if ($Body) { $Body | ConvertFrom-Json } else { $null }) }
Check 'restart 200 restarting=true' ((Outcome 200 '{"restarting":true}') -eq 'Restarting')
Check 'restart 200 without restarting=true fails' ((Outcome 200 '{"restarting":false}') -eq 'Failed')
Check 'restart 409 companion_busy reuses' ((Outcome 409 '{"error":"companion_busy"}') -eq 'Busy')
Check 'restart 409 identity mismatch fails' ((Outcome 409 '{"error":"instance_mismatch"}') -eq 'Failed')
Check 'restart transport failure fails' ((Outcome 0 '') -eq 'Failed')
Check 'restart 403 fails' ((Outcome 403 '{"error":"unauthorized"}') -eq 'Failed')
$web = 'https://shinick-han.github.io'
Check 'reuse matches same web origin' ($null -eq (Get-FalsifyReuseMismatch -ExistingWebOrigin $web -RequestedWebOrigin $web -Occupant $occupant -RequestedEditor $null))
Check 'reuse matches local-only' ($null -eq (Get-FalsifyReuseMismatch -ExistingWebOrigin $null -RequestedWebOrigin $null -Occupant $occupant -RequestedEditor $null))
Check 'reuse refuses web companion for -LocalOnly' ((Get-FalsifyReuseMismatch -ExistingWebOrigin $web -RequestedWebOrigin $null -Occupant $occupant -RequestedEditor $null) -match 'local-only')
Check 'reuse refuses local-only companion for website pairing' ((Get-FalsifyReuseMismatch -ExistingWebOrigin $null -RequestedWebOrigin $web -Occupant $occupant -RequestedEditor $null) -match 'website pairing')
$editor = [pscustomobject]@{ Root = 'D:\ed'; Manifest = 'D:\ed\candidate-manifest.json' }
$editorOccupant = [pscustomobject]@{ EditorRoot = 'D:\ed'; EditorManifest = 'D:\ed\candidate-manifest.json' }
Check 'reuse refuses requested editor on companion without one' ((Get-FalsifyReuseMismatch -ExistingWebOrigin $null -RequestedWebOrigin $null -Occupant $occupant -RequestedEditor $editor) -match 'PDF editor')
Check 'reuse matches identical editor' ($null -eq (Get-FalsifyReuseMismatch -ExistingWebOrigin $null -RequestedWebOrigin $null -Occupant $editorOccupant -RequestedEditor $editor))
Check 'reuse refuses other editor manifest' ((Get-FalsifyReuseMismatch -ExistingWebOrigin $null -RequestedWebOrigin $null -Occupant $editorOccupant -RequestedEditor ([pscustomobject]@{ Root = 'D:\ed'; Manifest = 'D:\other\candidate-manifest.json' })) -match 'PDF editor')

# --- Broker argument quoting round-trips through CommandLineToArgvW (PS5 Start-Process takes one string) ---
$values = @('D:\Repo Tree\falsify\app\local\server.py', '--port', '7816', 'with "quote"', 'trail\', 'trail space\ ', 'a\\"b', 'D:\dir\', '')
$parsed = Split-FalsifyCommandLine ('x.exe ' + (Join-FalsifyNativeArguments -Arguments $values))
Check 'native argument quoting round-trips exactly' ($parsed.Count -eq $values.Count + 1 -and (($parsed[1..($parsed.Count - 1)]) -join '|') -ceq ($values -join '|'))

# --- Static guards ------------------------------------------------------------------------------
$startSource = Get-Content -LiteralPath (Join-Path $root 'start-companion.ps1') -Raw
$moduleSource = Get-Content -LiteralPath (Join-Path $root 'companion-lifecycle.psm1') -Raw
Check 'never terminates processes' (($startSource + $moduleSource) -notmatch '(?i)Stop-Process|taskkill|\.Kill\(|CloseMainWindow')
$startCode = $startSource -replace '(?m)^\s*#.*$', ''
$moduleCode = $moduleSource -replace '(?m)^\s*#.*$', ''
Check 'broker uses one launcher with foreground or hidden background mode' (([regex]::Matches($startCode, 'Start-Process')).Count -eq 1 -and $startCode -match 'Start-Process @brokerStart' -and $startCode -match '\$brokerStart\.WindowStyle = ''Hidden''' -and $startCode -match '\$brokerStart\.NoNewWindow = \$true' -and $moduleCode -notmatch 'Start-Process')
Check 'launch lock released in finally' ($startSource -match '\}\s*finally\s*\{\s*Exit-FalsifyLauncherLock')
Check 'broker foreground wait happens after the lock is released' ($startSource.LastIndexOf('Exit-FalsifyLauncherLock') -lt $startSource.IndexOf('WaitForExit(500)'))
Check 'native HTTP disables redirects and proxies' ($moduleSource -match 'AllowAutoRedirect = \$false' -and $moduleSource -match 'UseProxy = \$false' -and $moduleSource -match 'client\.Timeout = ')
Check 'only the deliberate pairing line prints a token' (@($startSource -split "`n" | Where-Object { $_ -match 'Write-Host' -and $_ -match '(?i)\$token\b' }).Count -eq 1)
Check 'runtime preflight imports server and editor config before restart' ($startSource -match 'import server, editor_service; editor_service\.config_from' -and $startSource.IndexOf('editor_service.config_from') -lt $startSource.IndexOf('Invoke-FalsifyCompanionRestart'))

# --- Real lifecycle tests with stub companions --------------------------------------------------
$stubServer = @'
import json, os, secrets, socket, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
MODE = os.environ.get('FAKE_MODE', 'idle')
TOKEN = os.environ.get('FAKE_TOKEN', 'stub-token-0123456789abcdef')
MARK = os.environ.get('FAKE_MARK')
INSTANCE = secrets.token_hex(8)
def mark(text):
    if MARK:
        with open(MARK, 'a', encoding='utf-8') as handle: handle.write(text + '\n')
class Server(ThreadingHTTPServer):
    allow_reuse_address = False
    def server_bind(self):
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()
class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'
    def log_message(self, *_): pass
    def reply(self, status, payload, extra=None):
        raw = json.dumps(payload).encode()
        self.send_response(status); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(raw)))
        for key, value in (extra or {}).items(): self.send_header(key, value)
        self.end_headers(); self.wfile.write(raw)
    def launcher_ok(self):
        h = self.headers
        return (h.get('Host') == '127.0.0.1:%d' % self.server.server_port and h.get('Authorization') == 'Bearer ' + TOKEN
            and h.get('X-Falsify-Launcher') == '1' and h.get('Origin') is None and h.get('Sec-Fetch-Site') is None)
    def do_GET(self):
        h = self.headers
        mark('GET ' + self.path)
        if self.path == '/api/session':
            if h.get('Sec-Fetch-Site') != 'same-origin' or h.get('Origin') is not None: return self.reply(403, {'error': 'same_origin_browser_required'})
            return self.reply(200, {'token': TOKEN, 'mode': 'loopback-only'})
        if self.path == '/redirect': return self.reply(302, {}, {'Location': 'http://127.0.0.1:%d/target' % self.server.server_port})
        if self.path == '/target': return self.reply(200, {'target': True})
        if self.path == '/api/capabilities':
            if h.get('Authorization') != 'Bearer ' + TOKEN or h.get('Sec-Fetch-Site') != 'same-origin': return self.reply(403, {'error': 'unauthorized'})
            return self.reply(200, {'red': True, 'blue': True})
        if self.path == '/api/launcher/instance':
            if MODE == 'legacy' or not self.launcher_ok(): return self.reply(403, {'error': 'unauthorized'})
            return self.reply(200, {'schema': 'falsify-companion-lifecycle/1', 'pid': os.getpid(), 'instanceId': INSTANCE,
                'serverPath': str(Path(__file__).resolve()), 'webOrigin': self.server.web_origin, 'busy': MODE == 'busy'})
        self.reply(404, {'error': 'not_found'})
    def do_POST(self):
        mark('POST ' + self.path)
        if self.path == '/test/quit':
            self.reply(200, {}); threading.Thread(target=self.server.shutdown, daemon=True).start(); return
        if self.path != '/api/launcher/restart' or MODE == 'legacy': return self.reply(404, {'error': 'not_found'})
        if not self.launcher_ok() or self.headers.get('Content-Type') != 'application/json': return self.reply(403, {'error': 'unauthorized'})
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        if json.loads(body) != {'schema': 'falsify-companion-lifecycle/1', 'instanceId': INSTANCE}: return self.reply(409, {'error': 'instance_mismatch'})
        if MODE in ('busy', 'busy-at-restart'): return self.reply(409, {'error': 'companion_busy'})
        self.reply(200, {'restarting': True}); mark('restarting')
        threading.Thread(target=self.server.shutdown, daemon=True).start()
if __name__ == '__main__':
    args = sys.argv[1:]
    port = int(args[args.index('--port') + 1])
    server = Server(('127.0.0.1', port), Handler)
    server.web_origin = args[args.index('--web-origin') + 1] if '--web-origin' in args else None
    print('Falsify local: http://127.0.0.1:%d/ (stub)' % port, flush=True)
    mark('listening %d' % os.getpid())
    lifetime = float(os.environ.get('FAKE_LIFETIME', '0'))
    if lifetime: threading.Timer(lifetime, server.shutdown).start()
    try: server.serve_forever()
    finally:
        server.server_close(); mark('exited %d' % os.getpid())
'@
$stubEditorService = @'
import os
def config_from(root=None, manifest=None, source_root=None, node=None, environ=None):
    if os.environ.get('FAKE_PREFLIGHT_FAIL'): raise ValueError('stub editor configuration rejected')
    return None
'@
$listenCode = "import socket, sys; s = socket.socket(); s.bind(('127.0.0.1', int(sys.argv[1]))); s.listen(); print('ready', flush=True); sys.stdin.read()"

$python = Get-Command python -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
Check 'python available for real lifecycle tests' ([bool]$python)
$script:stubs = New-Object System.Collections.ArrayList

function Get-FreePort {
    $probe = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), 0
    $probe.Start()
    try { return ([System.Net.IPEndPoint]$probe.LocalEndpoint).Port } finally { $probe.Stop() }
}

function Start-Stub([int]$Port, [string]$Script, [hashtable]$Environment = @{}, [bool]$WebOrigin = $true, [string[]]$Arguments = $null) {
    if (-not $Arguments) {
        $Arguments = @('-u', $Script.Replace('\', '/'), '--port', [string]$Port)
        if ($WebOrigin) { $Arguments += @('--web-origin', 'https://shinick-han.github.io') }
    }
    $info = New-Object System.Diagnostics.ProcessStartInfo $python.Source
    $info.Arguments = Join-FalsifyNativeArguments -Arguments $Arguments
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    foreach ($name in $Environment.Keys) { $info.EnvironmentVariables[$name] = $Environment[$name] }
    $process = [System.Diagnostics.Process]::Start($info)
    $null = $process.StandardOutput.ReadToEndAsync(); $null = $process.StandardError.ReadToEndAsync()
    $null = $script:stubs.Add([pscustomobject]@{ Process = $process; Port = $Port })
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ([DateTime]::UtcNow -lt $deadline -and -not $process.HasExited -and (Test-FalsifyPortAvailable -Port $Port)) { Start-Sleep -Milliseconds 100 }
    return $process
}

function Stop-Stub($Stub) {
    if (-not $Stub.Process.HasExited) { $null = Invoke-FalsifyLoopbackRequest -Port $Stub.Port -Method POST -Path '/test/quit' -JsonBody '{}' -TimeoutSeconds 2 }
    try { $Stub.Process.StandardInput.Close() } catch { }
    $null = $Stub.Process.WaitForExit(10000)
}

# Host error views wrap long messages (PS7 adds "| " gutters) and, when colored, put ANSI CSI sequences inside wrapped
# words, so phrase checks strip CSI sequences first and then whitespace and gutters. Nothing else is removed.
function Remove-AnsiCsi([string]$Text) { $Text -replace '\x1b\[[0-?]*[ -/]*[@-~]', '' }
function ConvertTo-PhraseText([string]$Text) { (Remove-AnsiCsi $Text) -replace '[\s|]', '' }

$esc = [char]27
$plainError = "start-companion.ps1: Port 7816 is held by a different server script.`nconnect?port=[7817]"
$coloredError = "$esc[31;1mstart-companion.ps1: Port 7816 is held by a diff$esc[0m`r`n$esc[31;1m     | $esc[0m$esc[31;1merent server script.$esc[0m`n$esc[36m|$esc[0m connect?port=[7817]"
$expectedPhrase = 'start-companion.ps1:Port7816isheldbyadifferentserverscript.connect?port=[7817]'
Check 'phrase normalization: plain error text' ((ConvertTo-PhraseText $plainError) -ceq $expectedPhrase)
Check 'phrase normalization: ANSI-colored wrapped error equals plain' ((ConvertTo-PhraseText $coloredError) -ceq $expectedPhrase)
Check 'phrase normalization: gutter-only stripping misses colored phrase' (($coloredError -replace '[\s|]', '') -notmatch 'adifferentserverscript')
Check 'phrase normalization: bracket text without ESC preserved' ((ConvertTo-PhraseText '[31mkeep[0m') -ceq '[31mkeep[0m')

function Invoke-Launcher([string]$Project, [string[]]$Arguments, [hashtable]$Environment = @{}, [int]$TimeoutSeconds = 90) {
    $info = New-Object System.Diagnostics.ProcessStartInfo $powerShell
    $info.Arguments = Join-FalsifyNativeArguments -Arguments (@('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Project 'start-companion.ps1')) + $Arguments)
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    foreach ($name in @('FALSIFY_PDF_EDITOR_ROOT', 'FALSIFY_PDF_EDITOR_MANIFEST', 'FAKE_MODE', 'FAKE_PREFLIGHT_FAIL')) { $info.EnvironmentVariables.Remove($name) }
    foreach ($name in $Environment.Keys) { $info.EnvironmentVariables[$name] = $Environment[$name] }
    $process = [System.Diagnostics.Process]::Start($info)
    $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
    $done = $process.WaitForExit($TimeoutSeconds * 1000)
    if ($done) { $process.WaitForExit() }
    $output = if ($done) { $stdout.Result + $stderr.Result } else { '' }
    return [pscustomobject]@{ Done = $done; ExitCode = $(if ($done) { $process.ExitCode } else { $null }); Output = (ConvertTo-PhraseText $output); Text = (Remove-AnsiCsi $output) }
}

# Bounded failure diagnostic: ANSI-stripped launcher text, token-like values redacted, at most 1200 characters.
function Write-LauncherDiagnostic([string]$Name, $Result) {
    $text = $Result.Text -replace '(?i)(token[^:\r\n]*:\s*)\S+', '$1<redacted>' -replace '(?i)[a-z-]*token-[0-9a-f]+', '<redacted>'
    if ($text.Length -gt 1200) { $text = $text.Substring(0, 1200) + ' ...' }
    Write-Host "diag $Name (exit $($Result.ExitCode)):"
    Write-Host $text
}

function Read-Mark([string]$Path) { if (Test-Path -LiteralPath $Path) { Get-Content -LiteralPath $Path -Raw } else { '' } }
function Count-Text([string]$Text, [string]$Needle) { ([regex]::Matches($Text, [regex]::Escape($Needle))).Count }

if ($python) {
    $work = Join-Path ([System.IO.Path]::GetTempPath()) ('falsify-lifecycle-test-' + [guid]::NewGuid().ToString('N'))
    $testRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $project = Join-Path $work 'checkout with space'
    $other = Join-Path $work 'other checkout'
    try {
        foreach ($directory in @((Join-Path $project 'app\local'), (Join-Path $other 'app\local'))) { $null = New-Item -ItemType Directory -Path $directory -Force }
        foreach ($file in @('start-companion.ps1', 'falsify-connection.psm1', 'companion-lifecycle.psm1', 'pdf-editor-config.psm1')) { Copy-Item -LiteralPath (Join-Path $root $file) -Destination $project }
        foreach ($directory in @($project, $other)) {
            Set-Content -LiteralPath (Join-Path $directory 'app\local\server.py') -Value $stubServer -Encoding ascii
            Set-Content -LiteralPath (Join-Path $directory 'app\local\editor_service.py') -Value $stubEditorService -Encoding ascii
        }
        Set-Content -LiteralPath (Join-Path $project 'app\local\requirements.txt') -Value 'jsonschema==4.26.0' -NoNewline -Encoding ascii
        & $python.Source -m venv --without-pip (Join-Path $project '.venv')
        Check 'temporary checkout venv created' ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath (Join-Path $project '.venv\Scripts\python.exe')))
        $projectServer = [System.IO.Path]::GetFullPath((Join-Path $project 'app\local\server.py'))
        $otherServer = [System.IO.Path]::GetFullPath((Join-Path $other 'app\local\server.py'))
        $baseArgs = @('-NoInstall', '-NoPdf')

        # Foreign python -c listener: error before setup or HTTP, untouched; bounded native HTTP timeout.
        $port = Get-FreePort
        $foreign = Start-Stub -Port $port -Arguments @('-c', $listenCode, [string]$port)
        $result = Invoke-Launcher $project (@('-Port', [string]$port) + $baseArgs)
        Check 'foreign python -c listener: clear error with alternate-port advice, no setup' ($result.ExitCode -ne 0 -and $result.Output -match 'notthischeckout' -and $result.Output -match 'connect\?port=' -and $result.Output -notmatch 'preflight|Setup:|Restarting|Pairingtoken|Falsifylocal:')
        Check 'foreign python -c listener untouched' (-not $foreign.HasExited -and -not (Test-FalsifyPortAvailable -Port $port))
        $watch = [System.Diagnostics.Stopwatch]::StartNew()
        $silent = Invoke-FalsifyLoopbackRequest -Port $port -Path '/api/session' -TimeoutSeconds 1
        Check 'native HTTP times out within its bound' ($silent.Status -eq 0 -and $watch.Elapsed.TotalSeconds -lt 10)
        Stop-Stub $script:stubs[$script:stubs.Count - 1]

        # Spoof: the same stub from another checkout is foreign, and no HTTP request reaches it.
        $port = Get-FreePort
        $otherMark = Join-Path $work 'other.mark'
        $spoof = Start-Stub -Port $port -Script $otherServer -Environment @{ FAKE_MARK = $otherMark }
        $result = Invoke-Launcher $project (@('-Port', [string]$port) + $baseArgs)
        $foreignOk = $result.ExitCode -ne 0 -and $result.Output -match 'adifferentserverscript' -and $result.Output -notmatch 'preflight|Setup:|Restarting|Pairingtoken'
        Check 'other-checkout companion is foreign with no setup' $foreignOk
        if (-not $foreignOk) { Write-LauncherDiagnostic 'other-checkout companion' $result }
        Check 'other-checkout companion untouched and never contacted' (-not $spoof.HasExited -and (Read-Mark $otherMark) -notmatch 'GET|POST')
        Stop-Stub $script:stubs[$script:stubs.Count - 1]

        # Idle same-checkout companion (existing -u forward-slash argv): real OS identity and GET requests in this host.
        $port = Get-FreePort
        $oldMark = Join-Path $work 'idle-old.mark'
        $oldToken = 'idle-old-token-' + [guid]::NewGuid().ToString('N')
        $old = Start-Stub -Port $port -Script $projectServer -Environment @{ FAKE_MARK = $oldMark; FAKE_TOKEN = $oldToken }
        $realOccupant = Get-FalsifyPortOccupant -Port $port -ServerPath $projectServer
        Check 'real -u forward-slash companion is owned by OS identity' ($realOccupant.Kind -eq 'Owned' -and $realOccupant.Pid -eq $old.Id -and $realOccupant.WebOrigin -ceq 'https://shinick-han.github.io')
        Check 'real GET session bootstrap returns the token' ((Get-FalsifyCompanionToken -Port $port) -ceq $oldToken)
        Check 'real GET capabilities confirms a working companion' (Test-FalsifyLegacyCompanion -Port $port -Token $oldToken)
        $descriptor = Get-FalsifyCompanionDescriptor -Port $port -Token $oldToken
        Check 'real GET lifecycle descriptor validates against OS identity' ($descriptor.Status -eq 200 -and $null -eq (Test-FalsifyCompanionDescriptor -Json $descriptor.Json -Occupant $realOccupant -ServerPath $projectServer))
        Check 'native HTTP returns redirects without following them' ((Invoke-FalsifyLoopbackRequest -Port $port -Path '/redirect').Status -eq 302 -and (Read-Mark $oldMark) -notmatch 'GET /target')
        $savedProxy = [System.Net.WebRequest]::DefaultWebProxy
        $savedEnvironment = @{}
        foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY')) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name) }
        try {
            [System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy 'http://127.0.0.1:9', $false
            foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')) { [Environment]::SetEnvironmentVariable($name, 'http://127.0.0.1:9') }
            [Environment]::SetEnvironmentVariable('NO_PROXY', $null)
            Check 'native HTTP ignores configured proxies' ((Invoke-FalsifyLoopbackRequest -Port $port -Path '/target').Status -eq 200 -and (Read-Mark $oldMark) -match 'GET /target')
        } finally {
            [System.Net.WebRequest]::DefaultWebProxy = $savedProxy
            foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name]) }
        }
        $result = Invoke-Launcher $project (@('-Port', [string]$port) + $baseArgs) @{ FAKE_PREFLIGHT_FAIL = '1' }
        Check 'runtime preflight failure is reported before restart' ($result.ExitCode -ne 0 -and $result.Output -match 'preflightfailed' -and $result.Output -notmatch 'Restarting')
        $result = Invoke-Launcher $project @('-Port', [string]$port, '-NoInstall', '-PdfEditorRoot', (Join-Path $work 'missing editor'), '-PdfEditorManifest', (Join-Path $work 'missing editor\candidate-manifest.json'))
        Check 'invalid editor configuration is reported before restart' ($result.ExitCode -ne 0 -and $result.Output -notmatch 'Restarting')
        Check 'setup failures preserve the idle companion' (-not $old.HasExited -and (Read-Mark $oldMark) -notmatch 'POST /api/launcher/restart' -and $result.Output -notmatch [regex]::Escape($oldToken))

        # Owned idle restart: graceful restart through the API, then a new broker in this terminal.
        # The new stub must outlive the launcher readiness poll: one Get-FalsifyPortOccupant (listener + CIM lookup) measured
        # 3.5-6 s on Windows hosts, so a 4 s lifetime could exit mid-poll and be reported as stopped before listening.
        $newMark = Join-Path $work 'idle-new.mark'
        $result = Invoke-Launcher $project (@('-Port', [string]$port) + $baseArgs) @{ FAKE_MARK = $newMark; FAKE_LIFETIME = '20' }
        $null = $old.WaitForExit(10000)
        $idleOk = $result.Done -and $result.ExitCode -eq 0 -and $result.Output -match 'RestartingtheidleFalsifycompanion'
        Check 'idle restart: launcher completes with the new broker' $idleOk
        if (-not $idleOk) { Write-Host "diag idle restart: done=$($result.Done)"; Write-LauncherDiagnostic 'idle restart' $result }
        Check 'idle restart: old companion exited gracefully through its own restart' ($old.HasExited -and $old.ExitCode -eq 0 -and (Read-Mark $oldMark) -match 'restarting' -and (Read-Mark $oldMark) -match 'exited')
        Check 'idle restart: new broker listened and exited' ((Read-Mark $newMark) -match 'listening' -and (Read-Mark $newMark) -match 'exited')
        Check 'idle restart: token never printed' ($result.Output -notmatch [regex]::Escape($oldToken))

        # Busy, busy-at-restart and legacy companions: reused, token only in the pairing line; mismatch refused.
        foreach ($case in @(@{ Mode = 'busy'; Label = 'busy companion'; Phrase = 'busywithjobs' }, @{ Mode = 'busy-at-restart'; Label = 'companion busy at restart'; Phrase = 'becamebusy' }, @{ Mode = 'legacy'; Label = 'legacy companion'; Phrase = 'olderversion' })) {
            $port = Get-FreePort
            $mark = Join-Path $work ($case.Mode + '.mark')
            $token = $case.Mode + '-token-' + [guid]::NewGuid().ToString('N')
            $stub = Start-Stub -Port $port -Script $projectServer -Environment @{ FAKE_MARK = $mark; FAKE_TOKEN = $token; FAKE_MODE = $case.Mode }
            $result = Invoke-Launcher $project (@('-Port', [string]$port) + $baseArgs)
            Check "$($case.Label): reused with clear message" ($result.ExitCode -eq 0 -and $result.Output -match $case.Phrase -and $result.Output -match 'preserved' -and $result.Output -notmatch 'Falsifylocal:')
            Check "$($case.Label): token shown once, only as pairing output" ((Count-Text $result.Output $token) -eq 1 -and $result.Output.Contains("Pairingtoken(validuntilthatcompanionstops;donotshare):$token"))
            $result = Invoke-Launcher $project (@('-Port', [string]$port, '-LocalOnly') + $baseArgs)
            Check "$($case.Label): -LocalOnly mismatch refused without token" ($result.ExitCode -ne 0 -and $result.Output -match 'local-only' -and $result.Output -notmatch [regex]::Escape($token))
            Check "$($case.Label): kept running" (-not $stub.HasExited -and -not (Test-FalsifyPortAvailable -Port $port))
            Stop-Stub $script:stubs[$script:stubs.Count - 1]
        }
        $port = Get-FreePort
        $token = 'local-legacy-token-' + [guid]::NewGuid().ToString('N')
        $stub = Start-Stub -Port $port -Script $projectServer -Environment @{ FAKE_TOKEN = $token; FAKE_MODE = 'legacy' } -WebOrigin $false
        $result = Invoke-Launcher $project (@('-Port', [string]$port, '-LocalOnly') + $baseArgs)
        Check 'local-only legacy companion: reused without printing a token' ($result.ExitCode -eq 0 -and $result.Output -match 'local-only' -and $result.Output -notmatch [regex]::Escape($token))
        Stop-Stub $script:stubs[$script:stubs.Count - 1]
    } finally {
        foreach ($stub in $script:stubs) { Stop-Stub $stub }
        # Recursive delete only of this run's own random directory directly under the temp root.
        $resolvedWork = [System.IO.Path]::GetFullPath($work)
        $ownTestDirectory = [System.IO.Path]::GetDirectoryName($resolvedWork.TrimEnd('\')) + '\' -ieq $testRoot.TrimEnd('\') + '\' -and
            [System.IO.Path]::GetFileName($resolvedWork) -match '\Afalsify-lifecycle-test-[0-9a-f]{32}\z'
        if ($ownTestDirectory -and [System.IO.Directory]::Exists($resolvedWork)) {
            try { [System.IO.Directory]::Delete($resolvedWork, $true) } catch { Write-Host "note: temporary test directory left at $resolvedWork" }
        } else { Write-Host "note: temporary test directory not deleted (unexpected path) $resolvedWork" }
    }
}

# --- Launch lock: bounded wait, release and abandoned-holder recovery ---------------------------
$lockPort = Get-FreePort
$holderInfo = New-Object System.Diagnostics.ProcessStartInfo $powerShell
$holderInfo.Arguments = '-NoLogo -NoProfile -NonInteractive -Command "$m = New-Object System.Threading.Mutex -ArgumentList $false, $env:FALSIFY_TEST_MUTEX; $null = $m.WaitOne(); [Console]::Out.WriteLine(''held''); [Console]::Out.Flush(); $null = [Console]::In.ReadLine(); if ($env:FALSIFY_TEST_ABANDON -ne ''1'') { $m.ReleaseMutex() }"'
$holderInfo.UseShellExecute = $false; $holderInfo.CreateNoWindow = $true; $holderInfo.RedirectStandardInput = $true; $holderInfo.RedirectStandardOutput = $true
$holderInfo.EnvironmentVariables['FALSIFY_TEST_MUTEX'] = Get-FalsifyLauncherMutexName -Port $lockPort
foreach ($abandon in @('0', '1')) {
    $holderInfo.EnvironmentVariables['FALSIFY_TEST_ABANDON'] = $abandon
    $holder = [System.Diagnostics.Process]::Start($holderInfo)
    try {
        Check "lock holder ready (abandon=$abandon)" ($holder.StandardOutput.ReadLine() -eq 'held')
        $watch = [System.Diagnostics.Stopwatch]::StartNew()
        Check "lock wait is bounded while held (abandon=$abandon)" ((Test-Throws { Enter-FalsifyLauncherLock -Port $lockPort -TimeoutMilliseconds 500 }) -and $watch.Elapsed.TotalSeconds -lt 5)
    } finally { $holder.StandardInput.Close(); $null = $holder.WaitForExit(10000) }
    $lock = $null
    try { $lock = Enter-FalsifyLauncherLock -Port $lockPort -TimeoutMilliseconds 5000 } catch { $lock = $null }
    Check "lock acquired after holder exits (abandon=$abandon)" ($null -ne $lock)
    Exit-FalsifyLauncherLock -Mutex $lock
}
Check 'lock name is per-user and per-port' ((Get-FalsifyLauncherMutexName -Port 7816) -match '\ALocal\\FalsifyCompanionLauncher-S-1-[0-9-]+-7816\z' -and (Get-FalsifyLauncherMutexName -Port 7816) -ne (Get-FalsifyLauncherMutexName -Port 7817))

Write-Host ('{0} checks, {1} failed ({2} {3})' -f $script:checks, $script:failures, $PSVersionTable.PSEdition, $PSVersionTable.PSVersion)
if ($script:failures -ne 0 -or $script:checks -eq 0) { exit 1 }
exit 0
