Set-StrictMode -Version Latest

function Resolve-FalsifyPdfEditorConfig {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$ProjectDirectory,
          [string]$EditorRoot, [string]$EditorManifest,
          [switch]$Disabled)
    if ($Disabled) { return $null }
    $localConfig = Join-Path $ProjectDirectory '.pdf-editor.local.json'
    if (-not $EditorRoot -and -not $EditorManifest -and (Test-Path -LiteralPath $localConfig)) {
        $config = Get-Content -LiteralPath $localConfig -Raw | ConvertFrom-Json
        if (-not $config -or @($config.PSObject.Properties.Name).Count -ne 2 -or
            -not ($config.PSObject.Properties.Name -contains 'root') -or
            -not ($config.PSObject.Properties.Name -contains 'manifest') -or
            $config.root -isnot [string] -or $config.manifest -isnot [string]) {
            throw 'Invalid .pdf-editor.local.json: only string root and manifest are allowed.'
        }
        $EditorRoot = $config.root; $EditorManifest = $config.manifest
    }
    if (-not $EditorRoot -and -not $EditorManifest) { return $null }
    if (-not $EditorRoot -or -not $EditorManifest) {
        throw 'Set both PdfEditorRoot and PdfEditorManifest. A configured editor never falls back silently.'
    }
    foreach ($value in @($EditorRoot, $EditorManifest)) {
        if (-not [IO.Path]::IsPathRooted($value) -or $value.StartsWith('\\') -or $value -match '[\x00-\x1f]') {
            throw 'PDF editor configuration requires absolute local filesystem paths, never URLs or commands.'
        }
    }
    $resolvedRoot = (Resolve-Path -LiteralPath $EditorRoot -ErrorAction Stop).ProviderPath
    $resolvedManifest = (Resolve-Path -LiteralPath $EditorManifest -ErrorAction Stop).ProviderPath
    if (-not (Test-Path -LiteralPath (Join-Path $resolvedRoot 'src/web-bridge.mjs') -PathType Leaf) -or
        -not (Test-Path -LiteralPath $resolvedManifest -PathType Leaf)) {
        throw 'Configured PDF editor bridge or candidate manifest does not exist.'
    }
    [pscustomobject]@{ Root = $resolvedRoot; Manifest = $resolvedManifest }
}
Export-ModuleMember -Function Resolve-FalsifyPdfEditorConfig
