$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$w = 1400
$h = 900
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

function Brush($hex) { New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($hex)) }
function PenC($hex, $width) { New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml($hex)), $width }
function FontN($size, $style = [System.Drawing.FontStyle]::Regular) { New-Object System.Drawing.Font('Arial', [single]$size, $style) }

function RoundRect($x, $y, $ww, $hh, $r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $ww - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $ww - $d, $y + $hh - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $hh - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    $p
}

function CenterText($text, $font, $brush, $x, $y, $ww, $hh) {
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $g.DrawString($text, $font, $brush, (New-Object System.Drawing.RectangleF $x, $y, $ww, $hh), $sf)
}

function DrawLogo($x, $y, $ww, $hh) {
    $logoPath = Join-Path (Get-Location) 'jixels-logo-form-ni-tenje-cropped.jpeg'
    $logo = [System.Drawing.Image]::FromFile($logoPath)
    $g.DrawImage($logo, $x, $y, $ww, $hh)
    $logo.Dispose()
}

function CardBase($x, $y, $title) {
    $card = RoundRect $x $y 300 470 22
    $g.FillPath((Brush '#ffffff'), $card)
    $g.DrawPath((New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#d7dde7')), 2), $card)
    CenterText $title (FontN 18 ([System.Drawing.FontStyle]::Bold)) (Brush '#223047') $x ($y + 488) 300 28
}

function Photo($cx, $cy, $r) {
    $g.FillEllipse((Brush '#eef3f8'), $cx - $r, $cy - $r, $r * 2, $r * 2)
    $g.DrawEllipse((New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#f0c51b')), 5), $cx - $r, $cy - $r, $r * 2, $r * 2)
    CenterText 'PHOTO' (FontN 23 ([System.Drawing.FontStyle]::Bold)) (Brush '#8ca3be') ($cx - $r) ($cy - 20) ($r * 2) 40
}

function Details($x, $y, $dark = $false) {
    $idBrush = if ($dark) { Brush '#233044' } else { Brush '#d7e0ec' }
    $nameBrush = Brush '#f0c51b'
    $textBrush = if ($dark) { Brush '#233044' } else { Brush '#ffffff' }
    $g.DrawString('ID No. JXL-SA-001', (FontN 13 ([System.Drawing.FontStyle]::Bold)), $idBrush, $x, $y)
    $g.DrawString('James O. Atsali', (FontN 21 ([System.Drawing.FontStyle]::Bold)), $nameBrush, $x, $y + 28)
    $g.DrawString('Position  Sales Agent', (FontN 13 ([System.Drawing.FontStyle]::Bold)), $textBrush, $x, $y + 66)
    $g.DrawString('Phone     +254 713 111 666', (FontN 13 ([System.Drawing.FontStyle]::Bold)), $textBrush, $x, $y + 90)
}

$g.FillRectangle((Brush '#eef2f6'), 0, 0, $w, $h)
CenterText 'Front Card Design Options' (FontN 30 ([System.Drawing.FontStyle]::Bold)) (Brush '#233044') 0 28 $w 50

# Option 1
$x = 70; $y = 110
CardBase $x $y 'Option 1: Blue Header'
$g.FillRectangle((Brush '#4aa3df'), $x, $y, 300, 95)
DrawLogo ($x + 44) ($y + 8) 212 96
Photo ($x + 150) ($y + 190) 72
Details ($x + 38) ($y + 305) $true

# Option 2
$x = 395; $y = 110
CardBase $x $y 'Option 2: Blue Bottom'
DrawLogo ($x + 42) ($y + 16) 216 112
Photo ($x + 150) ($y + 205) 76
$panel = RoundRect ($x + 24) ($y + 318) 252 130 16
$g.FillPath((Brush '#4aa3df'), $panel)
Details ($x + 42) ($y + 337) $false

# Option 3
$x = 720; $y = 110
CardBase $x $y 'Option 3: Split Profile'
DrawLogo ($x + 42) ($y + 18) 216 112
$g.FillRectangle((Brush '#4aa3df'), $x + 22, $y + 165, 256, 250)
Photo ($x + 102) ($y + 280) 58
Details ($x + 162) ($y + 225) $false

# Option 4
$x = 1045; $y = 110
CardBase $x $y 'Option 4: Premium Bands'
DrawLogo ($x + 42) ($y + 18) 216 112
Photo ($x + 150) ($y + 205) 74
$bands = @(
    @(40, 'ID No. JXL-SA-001', '#d7e0ec'),
    @(74, 'James O. Atsali', '#f0c51b'),
    @(108, 'Sales Agent', '#ffffff'),
    @(142, '+254 713 111 666', '#ffffff')
)
foreach ($b in $bands) {
    $rr = RoundRect ($x + 30) ($y + 312 + $b[0]) 240 28 7
    $g.FillPath((Brush '#4aa3df'), $rr)
    CenterText $b[1] (FontN 13 ([System.Drawing.FontStyle]::Bold)) (Brush $b[2]) ($x + 30) ($y + 312 + $b[0]) 240 28
}

$out = Join-Path (Get-Location) 'design-options-preview.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output $out
