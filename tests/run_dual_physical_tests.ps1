$ErrorActionPreference = 'Stop'
$variable = 'TREEEXTRACT_EXPERIMENT_EDGE_CANDIDATE'
$previous = [Environment]::GetEnvironmentVariable($variable, 'Process')
$runner = Join-Path $PSScriptRoot 'run-modern-tests.ps1'
try {
    # Each mode starts a separate .NET process with an immutable startup setting.
    [Environment]::SetEnvironmentVariable($variable, $null, 'Process')
    Write-Output '=== Physical tests: production default (experiment disabled) ==='
    & $runner 'physical' 'expect-disabled' @args

    [Environment]::SetEnvironmentVariable($variable, '1', 'Process')
    Write-Output '=== Physical tests: explicit edge-candidate experiment ==='
    & $runner 'physical' 'expect-enabled' @args
}
finally {
    [Environment]::SetEnvironmentVariable($variable, $previous, 'Process')
}
