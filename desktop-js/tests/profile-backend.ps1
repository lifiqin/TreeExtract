param([Parameter(Mandatory=$true)][string]$RuntimeDirectory, [int]$Seconds = 4)
$ErrorActionPreference = 'Stop'
chcp 65001 > $null
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$target = Join-Path (Resolve-Path -LiteralPath $RuntimeDirectory).Path 'TreeExtractorBridge.exe'
$matches = @(Get-Process -Name TreeExtractorBridge -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path -ieq $target })
if ($matches.Count -ne 1) { throw 'Expected exactly one isolated backend.' }
$process = $matches[0]
$id = $process.Id
$cpu = $process.CPU
$watch = [Diagnostics.Stopwatch]::StartNew()
Start-Sleep -Seconds $Seconds
$watch.Stop()
$process = Get-Process -Id $id
@{
    elapsedSeconds = $watch.Elapsed.TotalSeconds
    cpuCorePercent = [Math]::Round((($process.CPU - $cpu) / $watch.Elapsed.TotalSeconds) * 100, 2)
    workingSetMB = [Math]::Round($process.WorkingSet64 / 1MB, 2)
    privateMB = [Math]::Round($process.PrivateMemorySize64 / 1MB, 2)
    threads = $process.Threads.Count
} | ConvertTo-Json -Compress
