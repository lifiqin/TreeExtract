param([string]$RuntimeDirectory)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $RuntimeDirectory) { $RuntimeDirectory = Join-Path $root 'desktop-js\runtime' }
$dll = Join-Path $RuntimeDirectory 'TreeExtractorBridge.dll'
$config = Join-Path $RuntimeDirectory 'TreeExtractorBridge.runtimeconfig.json'
foreach ($file in @($dll, $config, (Join-Path $RuntimeDirectory 'TreeExtractorBridge.exe'),
                    (Join-Path $RuntimeDirectory 'coreclr.dll'), (Join-Path $RuntimeDirectory 'hostfxr.dll'))) {
    if (-not (Test-Path -LiteralPath $file)) { throw "Missing self-contained backend file: $file" }
}

$path = (Resolve-Path -LiteralPath $dll).Path
try { $assembly = [Reflection.Assembly]::ReflectionOnlyLoadFrom($path) }
catch { $assembly = [Reflection.Assembly]::LoadFile($path) }
$references = @($assembly.GetReferencedAssemblies() | ForEach-Object { $_.Name })
if ($references -contains 'System.Windows.Forms') { throw 'The backend must not depend on System.Windows.Forms.' }

$options = (Get-Content -LiteralPath $config -Raw -Encoding UTF8 | ConvertFrom-Json).runtimeOptions
$included = @($options.includedFrameworks | Where-Object { $_.name -eq 'Microsoft.NETCore.App' -and $_.version -like '10.*' })
if ($options.tfm -ne 'net10.0' -or $included.Count -ne 1 -or $options.framework) {
    throw 'The backend is not a self-contained .NET 10 application.'
}

$sources = @(Get-ChildItem (Join-Path $root 'src') -Recurse -Filter '*.cs')
$sources += @(Get-ChildItem (Join-Path $root 'desktop-js\bridge') -Recurse -Filter '*.cs')
$matches = @($sources | Select-String -Encoding UTF8 -Pattern 'using\s+System\.Windows\.Forms|:\s*Form\b|Application\.Run\s*\(')
if ($matches.Count -gt 0) { throw ('Legacy UI references found: ' + ($matches -join '; ')) }

Write-Output ('HEADLESS BACKEND PASS: self-contained .NET ' + $included[0].version + ', no WinForms.')
