param(
    [ValidateRange(1024, 65535)][int]$Port = 7816,
    [switch]$LocalOnly,
    [switch]$NoPdf,
    [switch]$NoInstall,
    [switch]$Background,
    [string]$PairChallenge = '',
    [string]$PairState = '',
    [string]$PairProof = '',
    [string]$PdfEditorRoot = $env:FALSIFY_PDF_EDITOR_ROOT,
    [string]$PdfEditorManifest = $env:FALSIFY_PDF_EDITOR_MANIFEST
)
$ErrorActionPreference = 'Stop'
$projectDirectory = $PSScriptRoot
Import-Module (Join-Path $projectDirectory 'falsify-connection.psm1') -Force
Import-Module (Join-Path $projectDirectory 'companion-lifecycle.psm1') -Force
Import-Module (Join-Path $projectDirectory 'pdf-editor-config.psm1') -Force
$serverPath = [System.IO.Path]::GetFullPath((Join-Path $projectDirectory 'app/local/server.py'))
$requestedWebOrigin = if ($LocalOnly) { $null } else { (Get-FalsifyConnectionConstants).WebOrigin }
$alternatePort = if ($Port -lt 65535) { $Port + 1 } else { $Port - 1 }
$keptAdvice = "It was kept running unchanged and nothing was set up. To change it, stop it in its own window (Ctrl+C) once its work is saved, then start again, or use another port, e.g. -Port $alternatePort or falsify://connect?port=$alternatePort, and enter the same port on the website."
$haveAll = -not [string]::IsNullOrEmpty($PairChallenge) -and -not [string]::IsNullOrEmpty($PairState) -and -not [string]::IsNullOrEmpty($PairProof)
$haveAny = -not [string]::IsNullOrEmpty($PairChallenge) -or -not [string]::IsNullOrEmpty($PairState) -or -not [string]::IsNullOrEmpty($PairProof)
if ($haveAny -ne $haveAll -or ($haveAny -ne [bool]$Background)) { throw 'Rejected: one-time pairing requires -Background together with challenge, state and proof.' }
if ($Background -and $LocalOnly) { throw 'Rejected: one-time pairing cannot use -LocalOnly.' }
if ($Background) {
    foreach ($part in @($PairChallenge, $PairState, $PairProof)) {
        if ($part -notmatch '\A[A-Za-z0-9_-]{43}\z') { throw 'Rejected: pairing material is not a one-time nonce.' }
    }
}
function Complete-BackgroundPairing([string]$SessionToken) {
    if (-not $SessionToken -or -not (Register-FalsifyBrowserPairing -Port $Port -Token $SessionToken -Challenge $PairChallenge -State $PairState -Proof $PairProof)) {
        throw 'The companion refused one-time pairing. No website credential was issued.'
    }
    Write-Host "Approved $((Get-FalsifyConnectionConstants).WebOrigin) for a short-lived reconnect on port $Port. The running companion was kept. The process token was not shown."
}

# Reusing a running companion: say so plainly and deliberately show its pairing token in this terminal only.
function Show-ReusedCompanion([string]$Why, [AllowNull()][string]$WebOrigin, [string]$Token) {
    Write-Host "Falsify companion on 127.0.0.1 port $Port is already running from this checkout. $Why"
    Write-Host 'It was not stopped or restarted: its running jobs and finished results are preserved. No setup ran.'
    if ($WebOrigin) {
        Write-Host "It pairs with $WebOrigin. Paste the pairing token below into the website yourself; it is never put in a link."
        Write-Host "Pairing token (valid until that companion stops; do not share): $Token"
    } else {
        Write-Host "It is local-only: open http://127.0.0.1:$Port/ in this computer's browser."
    }
}

$launcherLock = Enter-FalsifyLauncherLock -Port $Port
$broker = $null
try {
    # Preflight: OS identity of any listener before setup or any HTTP request.
    $occupant = Get-FalsifyPortOccupant -Port $Port -ServerPath $serverPath
    if ($occupant.Kind -eq 'Foreign') {
        throw "Port $Port is already in use on this computer by a program that is not this checkout's Falsify companion ($($occupant.Reason)). Nothing was stopped, replaced or reused, and no setup ran. Start again on a free port, e.g. -Port $alternatePort or falsify://connect?port=$alternatePort, and enter the same port on the website."
    }
    $restartTarget = $null
    if ($occupant.Kind -eq 'Owned') {
        $failClosed = "Port $Port is held by this checkout's Falsify companion, but {0}. Nothing was stopped, restarted or set up. Stop it in its own window (Ctrl+C) if needed, or start again with -Port $alternatePort."
        $token = Get-FalsifyCompanionToken -Port $Port
        if (-not $token) { throw ($failClosed -f 'it did not answer the local pairing bootstrap') }
        $instance = Get-FalsifyCompanionDescriptor -Port $Port -Token $token
        if ($instance.Status -eq 200) {
            $problem = Test-FalsifyCompanionDescriptor -Json $instance.Json -Occupant $occupant -ServerPath $serverPath
            if ($problem) { throw ($failClosed -f "its lifecycle identity could not be verified ($problem)") }
            if ($instance.Json.busy) {
                $requestedEditor = Resolve-FalsifyPdfEditorConfig -ProjectDirectory $projectDirectory -EditorRoot $PdfEditorRoot -EditorManifest $PdfEditorManifest -Disabled:$NoPdf
                $mismatch = Get-FalsifyReuseMismatch -ExistingWebOrigin $instance.Json.webOrigin -RequestedWebOrigin $requestedWebOrigin -Occupant $occupant -RequestedEditor $requestedEditor
                if ($mismatch) { throw "The Falsify companion on port $Port is busy with jobs or recent results, and $mismatch. $keptAdvice" }
                if ($Background) { Complete-BackgroundPairing $token; return }
                Show-ReusedCompanion 'It is busy with jobs or recent results, so it was reused instead of restarted.' $instance.Json.webOrigin $token
                return
            }
            $restartTarget = $instance.Json.instanceId
        } elseif ($instance.Status -in @(403, 404)) {
            if (-not (Test-FalsifyLegacyCompanion -Port $Port -Token $token)) { throw ($failClosed -f 'it did not confirm a working companion') }
            $requestedEditor = Resolve-FalsifyPdfEditorConfig -ProjectDirectory $projectDirectory -EditorRoot $PdfEditorRoot -EditorManifest $PdfEditorManifest -Disabled:$NoPdf
            $mismatch = Get-FalsifyReuseMismatch -ExistingWebOrigin $occupant.WebOrigin -RequestedWebOrigin $requestedWebOrigin -Occupant $occupant -RequestedEditor $requestedEditor
            if ($mismatch) { throw "The Falsify companion on port $Port is an older version without automatic restart, and $mismatch. $keptAdvice" }
            if ($Background) { Complete-BackgroundPairing $token; return }
            Show-ReusedCompanion 'It is an older version without automatic restart, so it was reused; stop it with Ctrl+C in its window to pick up updates.' $occupant.WebOrigin $token
            return
        } else {
            throw ($failClosed -f 'its lifecycle endpoint did not answer as expected')
        }
    }

    # Setup and validation run before an idle companion is asked to restart, so a failure here leaves it serving.
    $venvDirectory = Join-Path $projectDirectory '.venv'
    $editorConfiguration = Resolve-FalsifyPdfEditorConfig -ProjectDirectory $projectDirectory -EditorRoot $PdfEditorRoot -EditorManifest $PdfEditorManifest -Disabled:$NoPdf
    if ($editorConfiguration) {
        # Hosts can expose several Node installations; use the first on PATH, as a plain `node` call would.
        $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $nodeCommand) { throw 'The configured PDF editor requires Node.js 24+. No installation or broker startup ran.' }
        & $nodeCommand.Source -e 'process.exit(parseInt(process.versions.node,10) >= 24 ? 0 : 1)'
        if ($LASTEXITCODE -ne 0) { throw 'The configured PDF editor requires Node.js 24+. Upgrade Node explicitly; nothing was installed.' }
    }
    $venvPython = Join-Path $venvDirectory 'Scripts/python.exe'
    if (-not (Test-Path -LiteralPath $venvPython)) {
        if ($NoInstall) { throw 'No local virtual environment. Run once without -NoInstall.' }
        $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
        if (-not $pythonCommand) { throw 'Install Python 3.10+ and reopen PowerShell first.' }
        & $pythonCommand.Source -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'
        if ($LASTEXITCODE -ne 0) { throw 'Python 3.10+ is required.' }
        Write-Host "Setup: creating project-local virtual environment $venvDirectory"
        & $pythonCommand.Source -m venv $venvDirectory
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the project-local virtual environment.' }
    }
    $requirementsFile = Join-Path $projectDirectory 'app/local/requirements.txt'
    $fullRequirements = Get-Content -LiteralPath $requirementsFile -Raw
    $wantedRequirements = if ($NoPdf) { 'jsonschema==4.26.0' } else { $fullRequirements }
    $installStamp = Join-Path $venvDirectory 'falsify-installed-requirements.txt'
    $installedRequirements = if (Test-Path -LiteralPath $installStamp) { Get-Content -LiteralPath $installStamp -Raw } else { $null }
    $alreadyInstalled = ($installedRequirements -ceq $wantedRequirements) -or ($NoPdf -and $installedRequirements -ceq $fullRequirements)
    if (-not $NoInstall -and -not $alreadyInstalled) {
        Write-Host 'Setup: installing pinned Python dependencies from PyPI into .venv (pip output follows).'
        if ($NoPdf) { & $venvPython -m pip install 'jsonschema==4.26.0' }
        else { & $venvPython -m pip install -r $requirementsFile }
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. No broker has been started.' }
        Set-Content -LiteralPath $installStamp -Value $wantedRequirements -NoNewline -Encoding ascii
        Write-Host 'Setup: dependencies installed. Later launches skip pip until requirements change.'
    }
    # No-bind, no-model runtime preflight (also under -NoInstall): the interpreter must import the companion and accept
    # the editor configuration exactly as the broker will, before any idle companion is asked to restart.
    $preflightArguments = @((Join-Path $projectDirectory 'app/local'))
    if ($editorConfiguration) { $preflightArguments += @($editorConfiguration.Root, $editorConfiguration.Manifest) }
    $previousPreference = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $preflightOutput = @(& $venvPython -c 'import sys; sys.path.insert(0, sys.argv[1]); import server, editor_service; editor_service.config_from(*(sys.argv[2:4] or [None, None]))' @preflightArguments 2>&1) }
    finally { $ErrorActionPreference = $previousPreference }
    if ($LASTEXITCODE -ne 0) {
        $detail = @($preflightOutput | ForEach-Object { [string]$_ } | Where-Object { $_.Trim() }) | Select-Object -Last 1
        throw "Companion runtime preflight failed ($detail). Nothing was stopped or started; run once without -NoInstall or fix the PDF editor configuration."
    }

    if ($restartTarget) {
        # Re-verify the same OS process and lifecycle identity after setup, immediately before asking it to restart.
        $failClosed = "The Falsify companion on port $Port changed while setup ran ({0}). Nothing was stopped or started; start again."
        if (-not (Test-FalsifySameOccupant -Before $occupant -After (Get-FalsifyPortOccupant -Port $Port -ServerPath $serverPath))) { throw ($failClosed -f 'listening process differs') }
        $instance = Get-FalsifyCompanionDescriptor -Port $Port -Token $token
        if ($instance.Status -ne 200 -or (Test-FalsifyCompanionDescriptor -Json $instance.Json -Occupant $occupant -ServerPath $serverPath) -or $instance.Json.instanceId -cne $restartTarget) {
            throw ($failClosed -f 'lifecycle identity differs')
        }
        $outcome = 'Busy'
        if (-not $instance.Json.busy) {
            if (-not (Test-FalsifySameOccupant -Before $occupant -After (Get-FalsifyPortOccupant -Port $Port -ServerPath $serverPath))) { throw ($failClosed -f 'listening process differs') }
            $outcome = Invoke-FalsifyCompanionRestart -Port $Port -Token $token -InstanceId $restartTarget
        }
        if ($outcome -eq 'Busy') {
            $mismatch = Get-FalsifyReuseMismatch -ExistingWebOrigin $instance.Json.webOrigin -RequestedWebOrigin $requestedWebOrigin -Occupant $occupant -RequestedEditor $editorConfiguration
            if ($mismatch) { throw "The Falsify companion on port $Port became busy with jobs or recent results, and $mismatch. It was kept running unchanged. Stop it in its own window (Ctrl+C) once its work is saved, then start again, or use -Port $alternatePort." }
            if ($Background) { Complete-BackgroundPairing $token; return }
            Show-ReusedCompanion 'It became busy with jobs or recent results, so it was reused instead of restarted.' $instance.Json.webOrigin $token
            return
        }
        if ($outcome -ne 'Restarting') { throw "The idle Falsify companion on port $Port did not accept a restart. It was not stopped; nothing else was changed. Stop it in its own window (Ctrl+C) and start again, or use -Port $alternatePort." }
        Write-Host "Restarting the idle Falsify companion on port $Port from this checkout (it had no running jobs or recent results)."
        if (-not (Wait-FalsifyPortReleased -Port $Port -TimeoutSeconds 30)) {
            throw "The idle Falsify companion on port $Port accepted a restart but has not released the port within 30 s. Nothing was killed; wait a moment and start again."
        }
    }
    $token = $null

    Write-Host 'Model CLIs found on PATH (nothing was run, installed or signed in):'
    foreach ($cli in Get-FalsifyCliStatus) {
        if ($cli.Installed) { Write-Host "  $($cli.Name): $($cli.Path)" } else { Write-Host "  $($cli.Name): not found" }
    }
    Write-Host '  Codex CLI and Claude Code are built-in adapters using your own subscription login. Nothing here asks for an API key.'
    Write-Host '  If one is not signed in, do it yourself in another terminal: "codex login", or run "claude" and use /login.'
    Write-Host '  CLI, model and effort are chosen per role in RED or BLUE on the website, not here. Other CLIs need a trusted custom stdio harness.'
    $brokerArguments = @($serverPath, '--port', [string]$Port)
    if ($editorConfiguration) {
        $brokerArguments += @('--pdf-editor-root', $editorConfiguration.Root, '--pdf-editor-manifest', $editorConfiguration.Manifest)
        Write-Host 'PDF editing: configured source-preserving reflow engine. Availability and page continuation are verified by the companion at startup.'
    } else {
        Write-Host 'PDF editing: legacy single-line mode. Configure a verified PDF editor locally for longer changes.'
    }
    if (-not $LocalOnly) { $brokerArguments += @('--web-origin', (Get-FalsifyConnectionConstants).WebOrigin) }
    $brokerPython = $venvPython
    if ($Background) {
        $pythonw = Join-Path $venvDirectory 'Scripts/pythonw.exe'
        if (Test-Path -LiteralPath $pythonw) { $brokerPython = $pythonw }
        $brokerArguments += @('--token-display', 'hidden', '--pairing-dir', (Get-FalsifyPairingDirectory))
        Write-Host 'Starting the companion in the background after local approval. The process token will not be shown.'
    } else {
        Write-Host 'Your own CLI login is used. Paste the pairing token printed below into the website yourself; it is never put in a link.'
        Write-Host 'This window must remain open. Ctrl+C stops the companion.'
    }
    Write-Host 'Only trust your selected harness code. The companion is not an OS sandbox.'
    # Foreground shares this terminal. Background uses one hidden process and does not print the process token.
    $brokerStart = @{
        FilePath = $brokerPython
        ArgumentList = (Join-FalsifyNativeArguments -Arguments $brokerArguments)
        PassThru = $true
    }
    if ($Background) { $brokerStart.WindowStyle = 'Hidden' } else { $brokerStart.NoNewWindow = $true }
    $broker = Start-Process @brokerStart
    $null = $broker.Handle
    $readiness = Wait-FalsifyBrokerReady -Process $broker -Port $Port -ServerPath $serverPath -TimeoutSeconds 120
    if ($Background) {
        if ($readiness -ne 'Ready') {
            $logDir = Join-Path (Split-Path -Parent (Get-FalsifyPairingDirectory)) 'logs'
            New-Item -ItemType Directory -Force -Path $logDir | Out-Null
            $exitCode = if ($broker.HasExited) { [string]$broker.ExitCode } else { 'timeout' }
            Add-Content -LiteralPath (Join-Path $logDir 'companion-errors.log') -Value ((Get-Date).ToUniversalTime().ToString('o') + " companion not ready on port $Port ($exitCode). No credential was issued.") -Encoding utf8
            throw 'Companion did not become ready. The error was recorded without credentials. No website credential was issued.'
        }
        $session = Get-FalsifyCompanionToken -Port $Port
        if (-not $session -or -not (Register-FalsifyBrowserPairing -Port $Port -Token $session -Challenge $PairChallenge -State $PairState -Proof $PairProof)) {
            throw 'The companion refused one-time pairing. No website credential was issued.'
        }
        Write-Host "Approved $((Get-FalsifyConnectionConstants).WebOrigin) for a short-lived reconnect on port $Port. The process token was not shown. The companion is running in the background."
        return
    }
    if ($readiness -eq 'Exited') { $broker.WaitForExit(); throw "Companion stopped with an error before listening (exit code $($broker.ExitCode)). If the port is occupied, choose -Port $alternatePort; do not terminate another program." }
    if ($readiness -eq 'Timeout') { Write-Host "Companion has not confirmed port $Port yet; the launch lock is released and this window keeps running it." }
} finally {
    Exit-FalsifyLauncherLock -Mutex $launcherLock
    $launcherLock = $null
}
while (-not $broker.WaitForExit(500)) { }
$broker.WaitForExit()
if ($broker.ExitCode -ne 0) { throw "Companion stopped with an error. If the port is occupied, choose -Port $alternatePort; do not terminate another program." }
