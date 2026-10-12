$ErrorActionPreference = 'Stop'
Import-Module (Join-Path (Split-Path -Parent $PSScriptRoot) 'pdf-editor-config.psm1') -Force
$checks = 0
function Check([string]$Name, [bool]$Pass) { $script:checks++; if (-not $Pass) { throw "FAIL: $Name" }; Write-Host "ok $Name" }
function Rejects([scriptblock]$Block) { try { $null = & $Block; return $false } catch { return $true } }
$root = Split-Path -Parent $PSScriptRoot
$emptyProject = Join-Path ([IO.Path]::GetTempPath()) ('falsify-pdf-config-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $emptyProject
try { Check 'unconfigured preserves legacy' ($null -eq (Resolve-FalsifyPdfEditorConfig -ProjectDirectory $emptyProject)) }
finally { Remove-Item -LiteralPath $emptyProject }
Check 'NoPdf disables even malformed explicit configuration' ($null -eq (Resolve-FalsifyPdfEditorConfig -ProjectDirectory $root -EditorRoot 'invalid' -Disabled))
Check 'partial root rejects' (Rejects { Resolve-FalsifyPdfEditorConfig -ProjectDirectory $root -EditorRoot 'C:\missing' })
Check 'partial manifest rejects' (Rejects { Resolve-FalsifyPdfEditorConfig -ProjectDirectory $root -EditorManifest 'C:\missing' })
Check 'relative paths reject' (Rejects { Resolve-FalsifyPdfEditorConfig -ProjectDirectory $root -EditorRoot '.\editor' -EditorManifest '.\candidate-manifest.json' })
Check 'URLs reject' (Rejects { Resolve-FalsifyPdfEditorConfig -ProjectDirectory $root -EditorRoot 'https://evil.invalid/editor' -EditorManifest 'https://evil.invalid/manifest' })
Check 'UNC paths reject' (Rejects { Resolve-FalsifyPdfEditorConfig -ProjectDirectory $root -EditorRoot '\\server\editor' -EditorManifest '\\server\manifest' })
Check 'missing local paths reject' (Rejects { Resolve-FalsifyPdfEditorConfig -ProjectDirectory $root -EditorRoot 'C:\falsify-no-such-editor' -EditorManifest 'C:\falsify-no-such-manifest.json' })
$tokens = $null; $errors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'pdf-editor-config.psm1'), [ref]$tokens, [ref]$errors)
Check 'module syntax' (@($errors).Count -eq 0)
# Windows PowerShell 5 strips inner double quotes from native arguments, so the launcher's Node probe must stay quote-free.
$intendedProbe = 'process.exit(parseInt(process.versions.node,10) >= 24 ? 0 : 1)'
$probeMatch = [regex]::Match((Get-Content -Raw -LiteralPath (Join-Path $root 'start-companion.ps1')), "& \`$nodeCommand\.Source -e '([^']*)'")
$probe = $probeMatch.Groups[1].Value
Check 'launcher Node probe is the quote-free form' ($probeMatch.Success -and $probe -ceq $intendedProbe -and $probe -notmatch '["`]')
function Invoke-NodeProbe([string]$Node, [string]$Script) {
    $ErrorActionPreference = 'Continue'
    $diagnostics = (& $Node -e $Script 2>&1 | Out-String).Trim()
    [pscustomobject]@{ ExitCode = $LASTEXITCODE; Diagnostics = $diagnostics }
}
$skipped = 0
# Get-Command returns every node on PATH; .Source of several would be invoked as one joined, unrecognized name.
$discoveryMatch = [regex]::Match((Get-Content -Raw -LiteralPath (Join-Path $root 'start-companion.ps1')), '(?m)^\s*(\$nodeCommand = Get-Command node -CommandType Application[^\r\n]*)\r?$')
Check 'launcher Node discovery selects the first PATH match' ($discoveryMatch.Success -and $discoveryMatch.Groups[1].Value.TrimEnd() -cmatch '\| Select-Object -First 1$')
$discovery = [scriptblock]::Create($discoveryMatch.Groups[1].Value + '; $nodeCommand')
$simulated = & {
    function Get-Command { [pscustomobject]@{ Source = 'C:\first\node.exe' }; [pscustomobject]@{ Source = 'C:\second\node.exe' } }
    & $discovery
}
Check 'launcher Node discovery keeps only the first of two installations' (@($simulated).Count -eq 1 -and $simulated.Source -ceq 'C:\first\node.exe')
$nodeCommand = & $discovery
if (-not $nodeCommand) {
    $skipped++
    Write-Host 'SKIP Node runtime probe: node is not on PATH; this check did not pass.'
} else {
    $major = [int](((& $nodeCommand.Source --version) | Out-String).Trim().TrimStart('v').Split('.')[0])
    $result = Invoke-NodeProbe $nodeCommand.Source $probe
    $expected = if ($major -ge 24) { 0 } else { 1 }
    Check "launcher Node probe parses in PowerShell $($PSVersionTable.PSVersion.Major) (no diagnostic: '$($result.Diagnostics)')" ($result.Diagnostics -eq '' -and $result.Diagnostics -notmatch 'SyntaxError')
    Check "launcher Node probe exits $expected for actual Node major $major (got $($result.ExitCode))" ($result.ExitCode -eq $expected)
    foreach ($sampleMajor in 18, 23, 24, 25) {
        $sample = Invoke-NodeProbe $nodeCommand.Source ($probe.Replace('process.versions.node', "$sampleMajor.9"))
        $sampleExpected = if ($sampleMajor -ge 24) { 0 } else { 1 }
        Check "probe threshold for sample major $sampleMajor exits $sampleExpected (got $($sample.ExitCode), diagnostic: '$($sample.Diagnostics)')" ($sample.Diagnostics -eq '' -and $sample.ExitCode -eq $sampleExpected)
    }
}
Write-Host "$checks checks passed; $skipped skipped; no installation, model, editor or server startup."
exit 0
