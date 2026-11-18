param(
    [Parameter(Mandatory = $true)][string]$InputPath,
    [Parameter(Mandatory = $true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $OutputPath) { throw 'Refusing to overwrite the JPEG test output.' }
Add-Type -AssemblyName System.Drawing
$original = [Drawing.Image]::FromFile($InputPath)
try {
    $bitmap = [Drawing.Bitmap]::new($original)
    try {
        $pixel = $bitmap.GetPixel(0, 0)
        $changed = [Drawing.Color]::FromArgb(255, 255 - $pixel.R, 255 - $pixel.G, 255 - $pixel.B)
        $bitmap.SetPixel(0, 0, $changed)
        $bitmap.Save($OutputPath, [Drawing.Imaging.ImageFormat]::Jpeg)
    }
    finally { $bitmap.Dispose() }
}
finally { $original.Dispose() }
