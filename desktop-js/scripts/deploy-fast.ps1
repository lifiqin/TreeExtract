param(
    [Parameter(Mandatory=$true)][string]$CandidateDirectory,
    [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9_-]{1,48}$')][string]$Tag
)

$ErrorActionPreference = 'Stop'
$desktop = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
$release = (Resolve-Path -LiteralPath (Join-Path $desktop 'release-net10')).Path
$source = (Resolve-Path -LiteralPath $CandidateDirectory).Path
$final = Join-Path $release 'TreeExtract-fast'
$stage = Join-Path $release ("TreeExtract-fast.stage-" + $Tag)
$backup = Join-Path $release ("TreeExtract-fast.backup-" + $Tag)
$prefix = $desktop.TrimEnd('\') + '\'

function Assert-WorkspacePath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the desktop workspace: $full"
    }
    if (Test-Path -LiteralPath $full) {
        $item = Get-Item -LiteralPath $full -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing a reparse point: $full"
        }
        $resolved = (Resolve-Path -LiteralPath $full).Path
        if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Resolved path is outside the desktop workspace: $resolved"
        }
    }
}

function Assert-NoReparsePoints([string]$Directory) {
    foreach ($item in Get-ChildItem -LiteralPath $Directory -Force) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing a reparse point: $($item.FullName)"
        }
        if ($item.PSIsContainer) { Assert-NoReparsePoints $item.FullName }
    }
}

function Copy-MissingItems([string]$From, [string]$To) {
    foreach ($item in Get-ChildItem -LiteralPath $From -Force) {
        $target = Join-Path $To $item.Name
        if (-not (Test-Path -LiteralPath $target)) {
            Copy-Item -LiteralPath $item.FullName -Destination $target -Recurse
        }
        elseif ($item.PSIsContainer -and (Get-Item -LiteralPath $target).PSIsContainer) {
            Copy-MissingItems $item.FullName $target
        }
    }
}

function Assert-NoRunningFastApp([string]$Directory) {
    $running = @(Get-Process -Name TreeExtract,TreeExtractorBridge -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path.StartsWith($Directory + '\', [StringComparison]::OrdinalIgnoreCase) })
    if ($running.Count -gt 0) { throw 'Close the running fast application before updating it.' }
}

function Get-Sha256([string]$Path) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $stream = [IO.File]::OpenRead($Path)
        try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)) }
        finally { $stream.Dispose() }
    }
    finally { $algorithm.Dispose() }
}

foreach ($path in @($release, $source, $final, $stage, $backup)) { Assert-WorkspacePath $path }
if (-not (Test-Path -LiteralPath $final -PathType Container)) { throw 'Existing fast application not found.' }
if ((Test-Path -LiteralPath $stage) -or (Test-Path -LiteralPath $backup)) {
    throw 'Stage or backup already exists; choose a new tag.'
}
Assert-NoReparsePoints $source
Assert-NoReparsePoints $final
Assert-NoRunningFastApp $final

# Stage the candidate and preserve additional files from the previous release.
Copy-Item -LiteralPath $source -Destination $stage -Recurse
Copy-MissingItems $final $stage
Assert-WorkspacePath $stage
Assert-NoReparsePoints $stage

$files = @(Get-ChildItem -LiteralPath $source -Recurse -File)
foreach ($file in $files) {
    $relative = $file.FullName.Substring($source.Length).TrimStart('\')
    $target = Join-Path $stage $relative
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "Missing staged file: $relative" }
    if ((Get-Sha256 $file.FullName) -ne (Get-Sha256 $target)) {
        throw "Staged file differs from candidate: $relative"
    }
}

# Recheck before switching; roll back the old directory if the switch fails.
foreach ($path in @($final, $stage, $backup)) { Assert-WorkspacePath $path }
Assert-NoReparsePoints $final
Assert-NoReparsePoints $stage
Assert-NoRunningFastApp $final
Move-Item -LiteralPath $final -Destination $backup
try {
    Move-Item -LiteralPath $stage -Destination $final
}
catch {
    if (-not (Test-Path -LiteralPath $final) -and (Test-Path -LiteralPath $backup)) {
        Move-Item -LiteralPath $backup -Destination $final
    }
    throw
}
Write-Output ("Fast app deployed: " + $final)
Write-Output ("Previous directory retained: " + $backup)
Write-Output ("Candidate files verified: " + $files.Count)
