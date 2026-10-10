# Convert the supplied artwork to PNG/ICO sizes without changing its design.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$iconDir = Join-Path $PSScriptRoot '../src-tauri/icons'
$artDir = Join-Path $PSScriptRoot '../web/assets/branding'
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null
foreach ($name in @('glass-light','glass-dark','illustrated-light','illustrated-dark')) {
    $source = [System.Drawing.Image]::FromFile((Join-Path $artDir "$name.png"))
    try {
        $bitmap = [System.Drawing.Bitmap]::new(256,256)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.DrawImage($source,0,0,256,256)
            $bitmap.Save((Join-Path $iconDir "$name.png"),[System.Drawing.Imaging.ImageFormat]::Png)
        } finally { $graphics.Dispose(); $bitmap.Dispose() }
    } finally { $source.Dispose() }
}
Copy-Item -LiteralPath (Join-Path $iconDir 'glass-light.png') -Destination (Join-Path $iconDir 'icon.png') -Force
$source = [System.Drawing.Image]::FromFile((Join-Path $artDir 'glass-light.png'))
$frames = @()
try {
    foreach ($size in @(16,24,32,48,64,128,256)) {
        $bitmap=[System.Drawing.Bitmap]::new($size,$size)
        $graphics=[System.Drawing.Graphics]::FromImage($bitmap)
        $memory=[System.IO.MemoryStream]::new()
        try {
            $graphics.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.DrawImage($source,0,0,$size,$size)
            $bitmap.Save($memory,[System.Drawing.Imaging.ImageFormat]::Png)
            $frames+=@{Size=$size;Bytes=$memory.ToArray()}
        } finally { $memory.Dispose();$graphics.Dispose();$bitmap.Dispose() }
    }
    $writer=[System.IO.BinaryWriter]::new([System.IO.File]::Create((Join-Path $iconDir 'icon.ico')))
    try {
        $writer.Write([uint16]0);$writer.Write([uint16]1);$writer.Write([uint16]$frames.Count)
        $offset=6+16*$frames.Count
        foreach ($frame in $frames) {
            $dimension=if($frame.Size -eq 256){0}else{$frame.Size}
            $writer.Write([byte]$dimension);$writer.Write([byte]$dimension);$writer.Write([byte]0);$writer.Write([byte]0)
            $writer.Write([uint16]1);$writer.Write([uint16]32);$writer.Write([uint32]$frame.Bytes.Length);$writer.Write([uint32]$offset)
            $offset+=$frame.Bytes.Length
        }
        foreach($frame in $frames){$writer.Write([byte[]]$frame.Bytes)}
    } finally {$writer.Dispose()}
} finally {$source.Dispose()}
