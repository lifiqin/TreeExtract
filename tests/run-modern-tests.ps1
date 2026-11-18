param(
    [Parameter(Mandatory = $true)][string]$Mode,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$TestArgs
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'desktop-js\scripts\find-dotnet.ps1')
$dotnet = Get-TreeExtractDotnet $root
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'

Push-Location -LiteralPath $root
try {
    & $dotnet build (Join-Path $PSScriptRoot 'TreeExtractor.Tests.csproj') -c Release --nologo
    if ($LASTEXITCODE -ne 0) { throw "Test build failed: $LASTEXITCODE" }
    $dll = Join-Path $PSScriptRoot 'bin\Release\net10.0-windows\win-x64\TreeExtractor.Tests.dll'
    & $dotnet $dll $Mode @TestArgs
    if ($LASTEXITCODE -ne 0) { throw "Tests failed: $LASTEXITCODE" }
}
finally { Pop-Location }
