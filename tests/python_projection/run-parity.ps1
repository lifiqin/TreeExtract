param([string]$Python = 'python')

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $root 'desktop-js\scripts\find-dotnet.ps1')
$dotnet = Get-TreeExtractDotnet $root
$project = Join-Path $PSScriptRoot 'oracle\ProjectionOracle.csproj'
$oracle = Join-Path $PSScriptRoot 'oracle\bin\Release\net10.0\ProjectionOracle.dll'
$variables = @('TREEEXTRACT_PROJECTION_DOTNET', 'TREEEXTRACT_PROJECTION_ORACLE', 'PYTHONDONTWRITEBYTECODE')
$previous = @{}
foreach ($name in $variables) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }

Push-Location -LiteralPath $root
try {
    & $dotnet build $project -c Release --nologo
    if ($LASTEXITCODE -ne 0) { throw "Projection oracle build failed: $LASTEXITCODE" }
    $env:TREEEXTRACT_PROJECTION_DOTNET = $dotnet
    $env:TREEEXTRACT_PROJECTION_ORACLE = $oracle
    $env:PYTHONDONTWRITEBYTECODE = '1'
    & $Python -m unittest discover -s tests/python_projection -p test_projection.py -v
    if ($LASTEXITCODE -ne 0) { throw "Python projection parity tests failed: $LASTEXITCODE" }
}
finally {
    foreach ($name in $variables) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
    Pop-Location
}
