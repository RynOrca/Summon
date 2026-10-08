$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$iconDir = Join-Path $PSScriptRoot '..\src-tauri\icons'
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null
$bitmap = [System.Drawing.Bitmap]::new(256, 256, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$graphics.Clear([System.Drawing.Color]::Transparent)

$shape = [System.Drawing.Drawing2D.GraphicsPath]::new()
$shape.AddArc(12, 12, 64, 64, 180, 90)
$shape.AddArc(180, 12, 64, 64, 270, 90)
$shape.AddArc(180, 180, 64, 64, 0, 90)
$shape.AddArc(12, 180, 64, 64, 90, 90)
$shape.CloseFigure()
$background = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 28, 28, 30))
$graphics.FillPath($background, $shape)

$stroke = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 229, 229, 231), 20)
$stroke.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$stroke.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$stroke.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$graphics.DrawLines($stroke, [System.Drawing.Point[]]@(
  [System.Drawing.Point]::new(174, 82),
  [System.Drawing.Point]::new(115, 82),
  [System.Drawing.Point]::new(85, 112),
  [System.Drawing.Point]::new(171, 153),
  [System.Drawing.Point]::new(141, 183),
  [System.Drawing.Point]::new(80, 183)
))

$pngPath = Join-Path $iconDir 'icon.png'
$icoPath = Join-Path $iconDir 'icon.ico'
$bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$pngBytes = [System.IO.File]::ReadAllBytes($pngPath)
$stream = [System.IO.File]::Create($icoPath)
$writer = [System.IO.BinaryWriter]::new($stream)
$writer.Write([uint16]0)
$writer.Write([uint16]1)
$writer.Write([uint16]1)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([uint16]1)
$writer.Write([uint16]32)
$writer.Write([uint32]$pngBytes.Length)
$writer.Write([uint32]22)
$writer.Write($pngBytes)
$writer.Dispose()
$stroke.Dispose()
$background.Dispose()
$shape.Dispose()
$graphics.Dispose()
$bitmap.Dispose()
