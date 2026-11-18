param([switch]$KeepBackup)

$ErrorActionPreference = 'Stop'
$desktop = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
$root = (Resolve-Path -LiteralPath (Split-Path -Parent $desktop)).Path
. (Join-Path $PSScriptRoot 'find-dotnet.ps1')
. (Join-Path $PSScriptRoot 'file-hash.ps1')
$dotnet = Get-TreeExtractDotnet $root
$runtime = Join-Path $desktop 'runtime'
$suffix = [guid]::NewGuid().ToString('N')
$stage = Join-Path $desktop ('runtime-stage-' + $suffix)
$backup = Join-Path $desktop ('runtime-backup-' + $suffix)

# Restrict swaps and cleanup to the desktop project directory.
function Assert-DesktopChild([string]$Path) {
    $prefix = $desktop.TrimEnd('\') + '\'
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the desktop project: $full"
    }
    if (Test-Path -LiteralPath $full) {
        if (((Get-Item -LiteralPath $full -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing a reparse-point directory: $full"
        }
        $resolved = (Resolve-Path -LiteralPath $full).Path
        if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Resolved path is outside the desktop project: $resolved"
        }
    }
}

# Never recursively copy or remove a runtime containing a junction or symlink.
function Test-ContainsReparsePoint([string]$Directory) {
    foreach ($item in Get-ChildItem -LiteralPath $Directory -Force) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $true }
        if ($item.PSIsContainer -and (Test-ContainsReparsePoint $item.FullName)) { return $true }
    }
    return $false
}

function Assert-NoRunningRuntime {
    $running = @(Get-Process -Name TreeExtractorBridge -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path -ieq (Join-Path $runtime 'TreeExtractorBridge.exe') })
    if ($running.Count -gt 0) { throw 'Close the running TreeExtract development application before rebuilding.' }
}

# Preserve existing user files that are not part of the new publish output.
function Copy-MissingItems([string]$Source, [string]$Destination) {
    foreach ($item in Get-ChildItem -LiteralPath $Source -Force) {
        $target = Join-Path $Destination $item.Name
        if (-not (Test-Path -LiteralPath $target)) {
            Copy-Item -LiteralPath $item.FullName -Destination $target -Recurse -Force
        }
        elseif ($item.PSIsContainer -and (Get-Item -LiteralPath $target).PSIsContainer) {
            Copy-MissingItems $item.FullName $target
        }
    }
}

# Write JSON as bytes: Windows PowerShell's native pipeline can insert a BOM.
function Test-BridgeStartup([string]$Executable) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $Executable
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $info.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    $previousInputEncoding = [Console]::InputEncoding
    try {
        [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
        if (-not $process.Start()) { throw 'Could not start the published backend.' }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $request = '{"id":1,"method":"defaults","params":{}}' + "`n"
        $bytes = [Text.Encoding]::UTF8.GetBytes($request)
        $inputStream = $process.StandardInput.BaseStream
        $inputStream.Write($bytes, 0, $bytes.Length)
        $inputStream.Close()
        if (-not $process.WaitForExit(30000)) {
            $process.Kill()
            throw 'Published backend startup check timed out.'
        }
        $reply = $stdout.Result
        try { $parsed = $reply | ConvertFrom-Json }
        catch { throw "Published backend returned invalid startup JSON: $reply $($stderr.Result)" }
        if ($process.ExitCode -ne 0 -or -not $parsed.ok) {
            throw "Published backend startup check failed (exit $($process.ExitCode)): $reply $($stderr.Result)"
        }
    }
    finally {
        $process.Dispose()
        [Console]::InputEncoding = $previousInputEncoding
    }
}

foreach ($path in @($runtime, $stage, $backup)) { Assert-DesktopChild $path }
Assert-NoRunningRuntime

$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'
$env:DOTNET_ROOT = Split-Path -Parent $dotnet
$env:DOTNET_ROOT_X64 = $env:DOTNET_ROOT
Push-Location -LiteralPath $root
try {
    & $dotnet publish (Join-Path $root 'backend\TreeExtractor.Backend.csproj') -c Release `
        -r win-x64 --self-contained true --output $stage --nologo
    if ($LASTEXITCODE -ne 0) { throw "Backend publish failed: $LASTEXITCODE" }
    foreach ($relative in @('TreeExtractorBridge.exe', 'TreeExtractorBridge.dll', 'coreclr.dll',
                             'hostfxr.dll', 'onnxruntime.dll', 'models\tree_cls.onnx',
                             'models\person_head.onnx', 'models\PERSON_HEAD_LICENSE.txt')) {
        if (-not (Test-Path -LiteralPath (Join-Path $stage $relative))) { throw "Publish is incomplete: $relative" }
    }
    $expectedPersonModelHash = '7DD9B514426B33423FFBC4E22FB6127F2145686441F2C398170585363C009575'
    $personModelHash = Get-TreeExtractSha256 (Join-Path $stage 'models\person_head.onnx')
    if ($personModelHash -ne $expectedPersonModelHash) { throw 'Published person/head model checksum is incorrect.' }
    $options = (Get-Content -LiteralPath (Join-Path $stage 'TreeExtractorBridge.runtimeconfig.json') -Raw -Encoding UTF8 | ConvertFrom-Json).runtimeOptions
    if ($options.tfm -ne 'net10.0' -or -not $options.includedFrameworks) { throw 'Publish is not self-contained .NET 10.' }
    Test-BridgeStartup (Join-Path $stage 'TreeExtractorBridge.exe')

    foreach ($path in @($runtime, $stage, $backup)) { Assert-DesktopChild $path }
    if (Test-Path -LiteralPath $backup) { throw 'Runtime backup already exists.' }
    if (Test-ContainsReparsePoint $stage) { throw 'Published runtime contains a junction or symlink.' }
    if (Test-Path -LiteralPath $runtime) {
        if (Test-ContainsReparsePoint $runtime) { throw 'Runtime contains a junction or symlink; move it outside before rebuilding.' }
        Copy-MissingItems $runtime $stage
        foreach ($path in @($runtime, $stage, $backup)) { Assert-DesktopChild $path }
        if (Test-ContainsReparsePoint $runtime) { throw 'Runtime changed before deployment.' }
        if (Test-ContainsReparsePoint $stage) { throw 'Staged runtime contains a junction or symlink.' }
        Assert-NoRunningRuntime
        Move-Item -LiteralPath $runtime -Destination $backup
    }
    try {
        Assert-DesktopChild $stage
        Assert-DesktopChild $runtime
        if (Test-Path -LiteralPath $runtime) { throw 'Runtime destination already exists.' }
        if (Test-ContainsReparsePoint $stage) { throw 'Staged runtime contains a junction or symlink.' }
        Move-Item -LiteralPath $stage -Destination $runtime
    }
    catch {
        if ((Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $runtime)) {
            Assert-DesktopChild $backup
            Assert-DesktopChild $runtime
            if (Test-ContainsReparsePoint $backup) { throw 'Cannot restore a runtime containing a junction or symlink.' }
            Move-Item -LiteralPath $backup -Destination $runtime
        }
        throw
    }
    if ((Test-Path -LiteralPath $backup) -and $KeepBackup) {
        Write-Output "Previous runtime retained at $backup"
    }
    elseif (Test-Path -LiteralPath $backup) {
        Assert-DesktopChild $backup
        try {
            if (Test-ContainsReparsePoint $backup) { throw 'Previous runtime contains a junction or symlink.' }
            Remove-Item -LiteralPath $backup -Recurse -Force
        }
        catch { Write-Warning "Previous runtime remains at $backup : $($_.Exception.Message)" }
    }
    Write-Output ("Self-contained .NET 10 backend built: " + (Join-Path $runtime 'TreeExtractorBridge.exe'))
}
finally {
    Pop-Location
    if ($KeepBackup -and (Test-Path -LiteralPath $stage)) {
        Write-Warning "Staging directory retained at $stage"
    }
    if (-not $KeepBackup -and (Test-Path -LiteralPath $stage) -and
        ((Test-Path -LiteralPath $runtime) -or -not (Test-Path -LiteralPath $backup))) {
        try {
            Assert-DesktopChild $stage
            if (Test-ContainsReparsePoint $stage) { throw 'Staging directory contains a junction or symlink.' }
            Remove-Item -LiteralPath $stage -Recurse -Force
        }
        catch { Write-Warning "Staging directory remains at $stage : $($_.Exception.Message)" }
    }
}
