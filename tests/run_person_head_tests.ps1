param(
    [switch]$RequireSymlink,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$TestArgs
)

$ErrorActionPreference = 'Stop'
$forward = @()
if ($RequireSymlink) { $forward += '--require-symlink' }
if ($TestArgs) { $forward += $TestArgs }
& (Join-Path $PSScriptRoot 'run-modern-tests.ps1') 'person-head' @forward
