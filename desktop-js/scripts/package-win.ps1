$ErrorActionPreference = 'Stop'
$desktop = Split-Path -Parent $PSScriptRoot
$builder = Join-Path $desktop 'node_modules\.bin\electron-builder.cmd'

if (-not (Test-Path -LiteralPath $builder)) {
    throw 'electron-builder is missing. Run scripts/setup.ps1 first.'
}

# Use a mirror by default; electron-builder verifies downloaded tools by checksum.
if (-not $env:ELECTRON_BUILDER_BINARIES_MIRROR) {
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
}

Set-Location -LiteralPath $desktop
& (Join-Path $PSScriptRoot 'build-bridge.ps1')
& $builder --win portable --x64 --publish never
if ($LASTEXITCODE -ne 0) { throw "Windows packaging failed: $LASTEXITCODE" }

Write-Output 'Portable executable: desktop-js/release-net10/TreeExtract-Portable.exe'
