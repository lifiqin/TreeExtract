function Get-TreeExtractDotnet([string]$ProjectRoot) {
    $candidates = @()
    if ($env:TREEEXTRACT_DOTNET) { $candidates += $env:TREEEXTRACT_DOTNET }
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'TreeExtract\dotnet-sdk\dotnet.exe') }
    $globalDotnet = Get-Command dotnet -ErrorAction SilentlyContinue
    if ($globalDotnet) { $candidates += $globalDotnet.Source }

    Push-Location -LiteralPath $ProjectRoot
    try {
        foreach ($candidate in $candidates) {
            if (-not (Test-Path -LiteralPath $candidate)) { continue }
            $version = & $candidate --version 2>$null
            if ($LASTEXITCODE -eq 0 -and $version -match '^10\.0\.\d+$' -and
                [version]$version -ge [version]'10.0.404') {
                return $candidate
            }
        }
    }
    finally { Pop-Location }
    throw 'Install .NET 10 SDK 10.0.404 or newer, or set TREEEXTRACT_DOTNET to its dotnet.exe.'
}
