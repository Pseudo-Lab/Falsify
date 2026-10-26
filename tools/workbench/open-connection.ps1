<#
Target of the per-user falsify:// protocol. Windows passes the clicked link as the single
argument. Port-only links and one-time pairing links are accepted, including the single empty
root slash Windows ShellExecute inserts. Anything else stops here, before any network, Python,
model or child process. A pairing link carries a port plus challenge, state and proof. It never
carries a bearer token, password, command, model or website origin. The companion always pairs
with the fixed hosted website origin, and only after a visible approval.
#>
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'falsify-connection.psm1') -Force

function Show-FalsifyVisibleApproval {
    $origin = (Get-FalsifyConnectionConstants).WebOrigin
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        $text = "Allow $origin to receive a short-lived local reconnect credential?`r`n`r`nThis does not run a model and does not reveal the server process token.`r`n`r`nNo cancels."
        # Button2 is No, so Enter does not approve.
        $result = [System.Windows.Forms.MessageBox]::Show($text, 'Falsify local companion', 'YesNo', 'Warning', 'Button2')
        return ($result -eq [System.Windows.Forms.DialogResult]::Yes)
    } catch {
        throw 'Visible approval is unavailable. Use the manual token fallback. Nothing was approved.'
    }
}

function Show-FalsifyVisibleNotice {
    param([Parameter(Mandatory)][string]$Sentence)
    $logDir = $null
    try { $logDir = Join-Path (Split-Path -Parent (Get-FalsifyPairingDirectory)) 'logs' } catch { $logDir = $null }
    if ($logDir) {
        try {
            New-Item -ItemType Directory -Force -Path $logDir | Out-Null
            Add-Content -LiteralPath (Join-Path $logDir 'companion-errors.log') -Value ((Get-Date).ToUniversalTime().ToString('o') + ' ' + $Sentence) -Encoding utf8
        } catch {}
    }
    if ($env:FALSIFY_CONNECT_DRY_RUN -eq '1') { return }
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        [void][System.Windows.Forms.MessageBox]::Show($Sentence, 'Falsify local companion', 'OK', 'Warning')
    } catch {}
}

# The protocol host is hidden. A port-only click still needs a visible window for the manual token.
# Returns false when no console can be shown, and then nothing is started.
function Show-FalsifyProtocolWindow {
    try {
        if (-not ('Falsify.ConsoleWindow' -as [type])) {
            Add-Type -Namespace Falsify -Name ConsoleWindow -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
'@
        }
        $hwnd = [Falsify.ConsoleWindow]::GetConsoleWindow()
        if ($hwnd -eq [IntPtr]::Zero) { return $false }
        return [Falsify.ConsoleWindow]::ShowWindow($hwnd, 5)
    } catch {
        return $false
    }
}

if ($args.Count -ne 1) { throw 'Rejected: expected exactly one falsify://connect?port=<1024-65535> (or falsify://connect/?port=<1024-65535>) link.' }
$link = ConvertFrom-FalsifyConnectLink -Uri ([string]$args[0])
[int]$port = $link.Port
$launcher = Join-Path $PSScriptRoot 'start-companion.ps1'
if (-not $link.Pairing) {
    if ($env:FALSIFY_CONNECT_DRY_RUN -eq '1') {
        Write-Output "DRY-RUN start-companion port=$port launcher=$launcher"
        return
    }
    if (-not (Show-FalsifyProtocolWindow)) {
        Show-FalsifyVisibleNotice 'The hidden click handler cannot show the process token. Run start-companion.ps1 in a terminal. Nothing was started.'
        exit 1
    }
    $Host.UI.RawUI.WindowTitle = "Falsify local companion (port $port)"
    Write-Host "Falsify connect link accepted for 127.0.0.1 port $port."
    & $launcher -Port $port
    return
}

$decision = Get-FalsifyApprovalDecision -Origin (Get-FalsifyConnectionConstants).WebOrigin -Choice $env:FALSIFY_CONNECT_APPROVAL
if ($decision -eq 'Ask') { $decision = if (Show-FalsifyVisibleApproval) { 'Approve' } else { 'Cancel' } }
if ($decision -ne 'Approve') {
    if ($env:FALSIFY_CONNECT_DRY_RUN -eq '1') { Write-Output "DRY-RUN pairing cancelled port=$port"; exit 2 }
    throw 'Cancelled: the fixed website was not approved. No companion was started and no credential was issued.'
}
if ($env:FALSIFY_CONNECT_DRY_RUN -eq '1') {
    Write-Output "DRY-RUN start-companion port=$port pairing=1 launcher=$launcher"
    return
}
Write-Host "Falsify pairing link accepted for 127.0.0.1 port $port. Nonces are not shown."
try {
    & $launcher -Port $port -Background -PairChallenge $link.Challenge -PairState $link.State -PairProof $link.Proof
} catch {
    Show-FalsifyVisibleNotice 'Pairing did not finish. See the companion error log. No credential was issued.'
    exit 1
}
