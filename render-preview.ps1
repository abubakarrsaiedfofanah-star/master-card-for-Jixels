$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$w = 1200
$h = 760
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

function Brush($hex) {
    New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($hex))
}

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
    $rect = New-Object System.Drawing.RectangleF $x, $y, $ww, $hh
    $g.DrawString($text, $font, $brush, $rect, $sf)
}

function LeftText($text, $font, $brush, $x, $y) {
    $g.DrawString($text, $font, $brush, $x, $y)
}

function DrawLogoImage($x, $y, $ww, $hh) {
    $logoPath = Join-Path (Get-Location) 'jixels-logo-form-ni-tenje-cropped.jpeg'
    $logo = [System.Drawing.Image]::FromFile($logoPath)
    $g.DrawImage($logo, $x, $y, $ww, $hh)
    $logo.Dispose()
}

function DrawFront($x, $y) {
    $cardBrush = Brush '#ffffff'
    $border = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#d7dde7')), 2
    $rr = RoundRect $x $y 330 520 24
    $g.FillPath($cardBrush, $rr)
    $g.DrawPath($border, $rr)
    DrawLogoImage ($x + 25) ($y + 31) 280 145
    $panel = RoundRect ($x + 46) ($y + 176) 238 319 118
    $g.FillPath((Brush '#1f4f95'), $panel)
    $g.FillEllipse((Brush '#f8fbff'), $x + 79, $y + 178, 172, 172)
    $penGold = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#f0c51b')), 5
    $g.DrawEllipse($penGold, $x + 79, $y + 178, 172, 172)
    $g.FillEllipse((Brush '#eef3f8'), $x + 93, $y + 192, 144, 144)
    CenterText 'PHOTO' (New-Object System.Drawing.Font('Arial', 23, [System.Drawing.FontStyle]::Bold)) (Brush '#8ca3be') ($x + 93) ($y + 244) 144 42
    CenterText 'ID No. 29352273' (New-Object System.Drawing.Font('Arial', 18, [System.Drawing.FontStyle]::Bold)) (Brush '#d7e0ec') $x ($y + 366) 330 32
    CenterText 'James O. Atsali' (New-Object System.Drawing.Font('Arial', 20, [System.Drawing.FontStyle]::Bold)) (Brush '#f0c51b') $x ($y + 402) 330 38
    CenterText 'Director' (New-Object System.Drawing.Font('Arial', 21, [System.Drawing.FontStyle]::Bold)) (Brush '#d7e0ec') $x ($y + 438) 330 35
}

function DrawBack($x, $y) {
    $cardBrush = Brush '#ffffff'
    $border = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#d7dde7')), 2
    $rr = RoundRect $x $y 330 520 24
    $g.FillPath($cardBrush, $rr)
    $g.DrawPath($border, $rr)
    $dark = Brush '#252e3b'
    $lineFont = New-Object System.Drawing.Font('Arial', 13, [System.Drawing.FontStyle]::Bold)
    LeftText 'If found please return to:' $lineFont $dark ($x + 76) ($y + 38)
    LeftText 'Jixels Technologies Ltd' $lineFont $dark ($x + 76) ($y + 62)
    LeftText 'P.O BOX 480-50101 Butere.' $lineFont $dark ($x + 76) ($y + 86)
    LeftText 'Phone:+254 713 111 666' $lineFont $dark ($x + 76) ($y + 110)
    $title = New-Object System.Drawing.Font('Arial', 14, [System.Drawing.FontStyle]::Bold)
    $bullet = New-Object System.Drawing.Font('Arial', 14, [System.Drawing.FontStyle]::Regular)
    $g.DrawString('Cardholder Responsibilities:', $title, $dark, $x + 35, $y + 158)
    $items = @(
        @(216, @('This ID card is the', 'property of Jixels', 'Technologies Ltd.')),
        @(288, @('Use of this card is', 'strictly for the person', 'to whom it is issued.')),
        @(360, @('Must be displayed at all', 'times while on company', 'premises.')),
        @(420, @('Report lost/stolen cards', 'immediately to HR.'))
    )
    foreach ($item in $items) {
        $yy = $item[0]
        $g.DrawString([char]0x2022, $bullet, $dark, $x + 45, $y + $yy - 18)
        for ($i = 0; $i -lt $item[1].Count; $i++) {
            $g.DrawString($item[1][$i], $bullet, $dark, $x + 76, $y + $yy - 18 + ($i * 20))
        }
    }
    DrawLogoImage ($x + 125) ($y + 472) 80 41
}

$g.FillRectangle((Brush '#eef2f6'), 0, 0, $w, $h)
CenterText 'ID Card Preview' (New-Object System.Drawing.Font('Arial', 28, [System.Drawing.FontStyle]::Bold)) (Brush '#27364a') 0 25 1200 50
DrawFront 205 110
DrawBack 665 110

$out = Join-Path (Get-Location) 'id-card-preview.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output $out
