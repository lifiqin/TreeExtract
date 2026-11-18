param(
    [string]$Python = 'python',
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $root 'desktop-js\scripts\find-dotnet.ps1')
$dotnet = Get-TreeExtractDotnet $root
$oracleProject = Join-Path $PSScriptRoot 'oracle\ProjectionOracle.csproj'
$benchmarkProject = Join-Path $PSScriptRoot 'benchmark\ProjectionBenchmark.csproj'
$oracle = Join-Path $PSScriptRoot 'oracle\bin\Release\net10.0\ProjectionOracle.dll'
$benchmark = Join-Path $PSScriptRoot 'benchmark\bin\Release\net10.0\ProjectionBenchmark.dll'
$previous = [Environment]::GetEnvironmentVariable('PYTHONDONTWRITEBYTECODE', 'Process')

Push-Location -LiteralPath $root
try {
    foreach ($project in @($oracleProject, $benchmarkProject)) {
        & $dotnet build $project -c Release --nologo
        if ($LASTEXITCODE -ne 0) { throw "Comparison build failed: $LASTEXITCODE" }
    }
    $env:PYTHONDONTWRITEBYTECODE = '1'
    & $Python (Join-Path $PSScriptRoot 'compare.py') --dotnet $dotnet --oracle $oracle `
        --benchmark $benchmark --output-dir $OutputDirectory
    if ($LASTEXITCODE -ne 0) { throw "Projection comparison failed: $LASTEXITCODE" }
}
finally {
    [Environment]::SetEnvironmentVariable('PYTHONDONTWRITEBYTECODE', $previous, 'Process')
    Pop-Location
}
