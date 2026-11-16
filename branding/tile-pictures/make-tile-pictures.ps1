# Makes Time Slide tile pictures in the style of Stafford's Site/Software/Shop pictures:
# 1280x720 white, grey ring with blue Clifford C, grey divider, blue word(s), grey+blue bars at the bottom.
# The ring/C/divider/bars are copied pixel-for-pixel from the original Site picture.
# Usage: edit $labels in the make section, then:
#   powershell -ExecutionPolicy Bypass -File make-tile-pictures.ps1 -Mode make -OutDir <folder>
param([string]$Mode = 'compare', [string]$OutDir = '', [string]$FontFile = 'segoeuib.ttf')
Add-Type -AssemblyName System.Drawing
$img = $PSScriptRoot
$pfc = New-Object System.Drawing.Text.PrivateFontCollection
$pfc.AddFontFile("C:\Windows\Fonts\$FontFile")
$fam = $pfc.Families[0]
$blue = [System.Drawing.Color]::FromArgb(27,69,150)
$site = [System.Drawing.Bitmap]::FromFile("$img\site.png")

function PathFor([string]$text, [float]$em) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddString($text, $fam, 1, $em, (New-Object System.Drawing.PointF(0,0)), [System.Drawing.StringFormat]::GenericTypographic)
  return $p
}

# Site layout: logo group (ring x 170..550, divider at 610) and text starting at x=681, cap-centred on y~362.
# Software layout: same group moved 90px left, text 2/3 size.
function Make([string[]]$lines, [float]$em, [int]$shift, [int]$textX) {
  $bmp = New-Object System.Drawing.Bitmap 1280, 720
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.InterpolationMode = 'NearestNeighbor'; $g.PixelOffsetMode = 'Half'
  $g.Clear([System.Drawing.Color]::White)
  # logo group: x 160..630, y 160..560 of the Site picture
  # ring + C (x 160..560), then the divider (x 595..625) -- in the Software picture the divider moves 12px more than the ring
  $g.DrawImage($site, (New-Object System.Drawing.Rectangle (160 - $shift), 160, 400, 400), (New-Object System.Drawing.Rectangle 160, 160, 400, 400), 'Pixel')
  $dshift = if ($shift -gt 0) { $shift + 12 } else { 0 }
  $g.DrawImage($site, (New-Object System.Drawing.Rectangle (595 - $dshift), 160, 30, 400), (New-Object System.Drawing.Rectangle 595, 160, 30, 400), 'Pixel')
  # bottom bars
  $g.DrawImage($site, (New-Object System.Drawing.Rectangle 0, 670, 1280, 50), (New-Object System.Drawing.Rectangle 0, 670, 1280, 50), 'Pixel')
  # text: cap height of H for this em, lines spaced by 1.25 cap heights... baseline-based
  $hb = (PathFor 'H' $em).GetBounds()
  $cap = $hb.Height; $capTop = $hb.Top
  $gap = [math]::Round($cap * 0.55)
  $block = $lines.Count * $cap + ($lines.Count - 1) * $gap
  $top = 362 - $block / 2
  $brush = New-Object System.Drawing.SolidBrush $blue
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $p = PathFor $lines[$i] $em
    $b = $p.GetBounds()
    $m = New-Object System.Drawing.Drawing2D.Matrix
    # the originals are ~3.3% narrower than Segoe UI Bold: squeeze horizontally
    $m.Translate($textX, $top + $i * ($cap + $gap) - $capTop)
    $m.Scale(0.967, 1)
    $m.Translate(-$b.Left, 0)
    $p.Transform($m)
    $g.FillPath($brush, $p)
  }
  $g.Dispose()
  return $bmp
}

function Diff($a, $b) {
  $n = 0; $t = 0
  for ($y = 150; $y -lt 520; $y += 2) { for ($x = 500; $x -lt 1279; $x += 2) {
    $ca = $a.GetPixel($x,$y); $cb = $b.GetPixel($x,$y)
    $ia = $ca.R -lt 150; $ib = $cb.R -lt 150
    if ($ia -or $ib) { $t++; if ($ia -ne $ib) { $n++ } } } }
  return "{0:P1} of ink pixels differ" -f ($n / [math]::Max($t,1))
}

function W([string]$t, [float]$em) { return (PathFor $t $em).GetBounds().Width * 0.967 }

if ($Mode -eq 'make') {
  $pS = PathFor 'Site' 100; $big = 100 * 172 / $pS.GetBounds().Height        # Site/Shop size
  $pW = PathFor 'Software' 100; $small = 100 * 113 / $pW.GetBounds().Height  # Software size
  $labels = [ordered]@{ 'long-lead' = 'Long lead'; 'project-management' = 'Project management'; 'test-material' = 'Test material'; 'guarantee-work' = 'Guarantee work'; 'layout' = 'Layout' }
  foreach ($k in $labels.Keys) {
    $t = $labels[$k]
    if (681 + (W $t $big) -le 1200) { $bmp = Make @($t) $big 0 681; $how = 'Site size' }
    elseif (563 + (W $t ($small * 0.8)) -le 1160) {
      $em = [math]::Min($small, $small * (1160 - 563) / (W $t $small))
      $bmp = Make @($t) $em 90 563; $how = "one line, em $([math]::Round($em))"
    }
    else {
      $lines = $t -split ' ', 2
      $em = $small * 0.85
      $widest = ($lines | ForEach-Object { W $_ $small } | Measure-Object -Maximum).Maximum
      $em = [math]::Min($em, $small * (1160 - 563) / $widest)
      $bmp = Make $lines $em 90 563; $how = "two lines, em $([math]::Round($em))"
    }
    $bmp.Save("$OutDir\$k.png", [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    "$k : $how"
  }
  exit
}

if ($Mode -eq 'compare') {
  # em chosen so "Site" ink height matches (172px from i-dot to baseline)
  $p = PathFor 'Site' 100; $em = 100 * 172 / $p.GetBounds().Height
  $siteNew = Make @('Site') $em 0 681
  $shopNew = Make @('Shop') $em 0 681
  $p = PathFor 'Software' 100; $em2 = 100 * 113 / $p.GetBounds().Height
  $softNew = Make @('Software') $em2 90 563
  "$FontFile Site: "     + (Diff $siteNew $site)
  "$FontFile Shop: "     + (Diff $shopNew ([System.Drawing.Bitmap]::FromFile("$img\shop.png")))
  "$FontFile Software: " + (Diff $softNew ([System.Drawing.Bitmap]::FromFile("$img\software.png")))
  if ($OutDir) { $siteNew.Save("$OutDir\check-site.png"); $softNew.Save("$OutDir\check-software.png") }
}
