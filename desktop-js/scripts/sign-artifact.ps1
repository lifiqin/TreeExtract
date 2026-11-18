param(
    [Parameter(Mandatory = $true)][string]$Artifact,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256,
    [Parameter(Mandatory = $true)][string]$CertificateThumbprint,
    [Parameter(Mandatory = $true)][string]$TimestampUrl,
    [Parameter(Mandatory = $true)][string]$SignTool,
    [ValidateSet('CurrentUser', 'LocalMachine')][string]$CertificateStore = 'CurrentUser'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'file-hash.ps1')
$thumbprint = $CertificateThumbprint.Replace(' ', '').ToUpperInvariant()
if ($thumbprint -notmatch '^[0-9A-F]{40}$') {
    throw 'CertificateThumbprint must be a 40-character SHA-1 certificate thumbprint.'
}
$expectedHash = $ExpectedSha256.ToUpperInvariant()
if ($expectedHash -notmatch '^[0-9A-F]{64}$') { throw 'ExpectedSha256 must be a SHA-256 hash.' }
$timestamp = $null
if (-not [Uri]::TryCreate($TimestampUrl, [UriKind]::Absolute, [ref]$timestamp) -or
    $timestamp.Scheme -ne 'https') {
    throw 'TimestampUrl must be an absolute HTTPS RFC 3161 timestamp service URL.'
}
foreach ($file in @($Artifact, $SignTool)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "File not found: $file" }
}
$artifactPath = (Resolve-Path -LiteralPath $Artifact).Path
$toolPath = (Resolve-Path -LiteralPath $SignTool).Path
if ([IO.Path]::GetFileName($toolPath) -ine 'signtool.exe') { throw 'SignTool must be signtool.exe.' }
# Do not let a PowerShell 7 PSModulePath select an incompatible module in Windows PowerShell 5.1.
$securityModule = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
if (-not (Test-Path -LiteralPath $securityModule)) { throw 'PowerShell security module is unavailable.' }
Import-Module -Name $securityModule -ErrorAction Stop
$toolSignature = Get-AuthenticodeSignature -LiteralPath $toolPath
if ($toolSignature.Status -ne 'Valid' -or $null -eq $toolSignature.SignerCertificate) {
    throw 'SignTool must have a valid trusted Microsoft Authenticode signature.'
}
$publisher = $toolSignature.SignerCertificate.GetNameInfo('SimpleName', $false)
if ($publisher -notin @('Microsoft Corporation', 'Microsoft Windows')) {
    throw 'SignTool must be signed by Microsoft Corporation or Microsoft Windows.'
}
$item = Get-Item -LiteralPath $artifactPath -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Refusing to replace a symbolic-link artifact.'
}
if ($item.Extension -notin @('.exe', '.dll')) { throw 'Only .exe and .dll artifacts are supported.' }
if ((Get-TreeExtractSha256 $artifactPath) -ne $expectedHash) {
    throw 'The artifact does not match ExpectedSha256.'
}

# Private keys remain in the Windows certificate store or hardware provider.
$storePath = 'Cert:\' + $CertificateStore + '\My'
$certificates = @(Get-ChildItem -LiteralPath $storePath -ErrorAction SilentlyContinue |
    Where-Object { $_.Thumbprint -eq $thumbprint -and $_.HasPrivateKey })
if ($certificates.Count -ne 1) { throw 'The requested certificate with a private key was not found uniquely.' }
$certificate = $certificates[0]
$codeSigningOid = '1.3.6.1.5.5.7.3.3'
$eku = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' })
$codeSigningUsage = @($eku | ForEach-Object { $_.EnhancedKeyUsages } |
    Where-Object { $_.Value -eq $codeSigningOid })
if ($codeSigningUsage.Count -eq 0) { throw 'The certificate is not valid for code signing.' }
if ([DateTime]::Now -lt $certificate.NotBefore -or [DateTime]::Now -gt $certificate.NotAfter) {
    throw 'The code signing certificate is outside its validity period.'
}

$id = [guid]::NewGuid().ToString('N')
$stage = Join-Path $item.DirectoryName ('.signing-' + $id + $item.Extension)
$backup = Join-Path $item.DirectoryName ('.unsigned-backup-' + $id + $item.Extension)
Copy-Item -LiteralPath $artifactPath -Destination $stage
try {
    if ((Get-TreeExtractSha256 $stage) -ne $expectedHash) {
        throw 'The staged artifact does not match ExpectedSha256.'
    }
    $signArguments = @('sign', '/fd', 'SHA256', '/sha1', $thumbprint,
                       '/tr', $timestamp.AbsoluteUri, '/td', 'SHA256')
    if ($CertificateStore -eq 'LocalMachine') { $signArguments += '/sm' }
    $signArguments += $stage
    & $toolPath @signArguments
    if ($LASTEXITCODE -ne 0) { throw "SignTool signing failed: $LASTEXITCODE" }
    & $toolPath verify /pa /all /tw $stage
    if ($LASTEXITCODE -ne 0) { throw "SignTool verification failed: $LASTEXITCODE" }
    $signature = Get-AuthenticodeSignature -LiteralPath $stage
    if ($signature.Status -ne 'Valid' -or $null -eq $signature.TimeStamperCertificate) {
        throw 'The signed artifact is not trusted or has no verified timestamp.'
    }
    if ($signature.SignerCertificate.Thumbprint -ne $thumbprint) {
        throw 'The artifact was signed by an unexpected certificate.'
    }
    if ((Get-TreeExtractSha256 $artifactPath) -ne $expectedHash) {
        throw 'The original artifact changed while signing; refusing to replace it.'
    }
    [IO.File]::Replace($stage, $artifactPath, $backup)
    Write-Output "Signed artifact: $artifactPath"
    Write-Output "Unsigned rollback copy: $backup"
    Write-Output ('SHA256: ' + (Get-TreeExtractSha256 $artifactPath))
}
finally {
    if (Test-Path -LiteralPath $stage) { Write-Warning "Signing stage retained: $stage" }
}
