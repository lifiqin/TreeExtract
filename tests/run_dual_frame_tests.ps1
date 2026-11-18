$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'run-modern-tests.ps1') 'dual' @args
