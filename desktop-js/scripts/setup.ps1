$ErrorActionPreference = 'Stop'
$desktop = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $desktop

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22 or newer is required.' }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm is required.' }
& npm.cmd install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm install failed: $LASTEXITCODE" }

$electron = Join-Path $desktop 'node_modules\electron'
$package = Get-Content -LiteralPath (Join-Path $electron 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $package.version
$dist = Join-Path $electron 'dist'
$exe = Join-Path $dist 'electron.exe'
if (-not (Test-Path -LiteralPath $exe)) {
    if (Test-Path -LiteralPath $dist) { throw 'Electron dist is incomplete; inspect it before retrying.' }
    $archive = "electron-v$version-win32-x64.zip"
    $checksums = Get-Content -LiteralPath (Join-Path $electron 'checksums.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $expected = $checksums.PSObject.Properties[$archive].Value
    if (-not $expected) { throw 'No official checksum for the Electron binary.' }
    $download = Join-Path $env:TEMP ('treeextract-electron-' + [guid]::NewGuid().ToString('N') + '.zip')
    $url = "https://npmmirror.com/mirrors/electron/$version/$archive"
    & curl.exe --fail --location --retry 2 --max-time 300 --output $download $url
    if ($LASTEXITCODE -ne 0) { throw "Electron download failed: $LASTEXITCODE" }
    $actual = (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash
    if ($actual -ne $expected) { throw 'Electron SHA256 verification failed.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($download, $dist)
    Set-Content -LiteralPath (Join-Path $electron 'path.txt') -Value 'electron.exe' -NoNewline -Encoding ascii
}
& (Join-Path $PSScriptRoot 'build-bridge.ps1')
Write-Output 'Setup completed. Run StartTreeExtract.cmd.'
