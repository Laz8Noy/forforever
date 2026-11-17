# 用法: powershell -NoProfile -File scripts/make-icons.ps1 -Source design/icon-source.png
param(
  [string]$Source = "design/icon-source.png",
  [string]$ResDir = "android/app/src/main/res"
)
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile((Resolve-Path $Source))
$sizes = @{ 'mipmap-mdpi'=48; 'mipmap-hdpi'=72; 'mipmap-xhdpi'=96; 'mipmap-xxhdpi'=144; 'mipmap-xxxhdpi'=192 }
foreach ($k in $sizes.Keys) {
  $n = $sizes[$k]
  $bmp = New-Object System.Drawing.Bitmap $n, $n
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.DrawImage($src, 0, 0, $n, $n)
  $dir = Join-Path $ResDir $k
  foreach ($name in @('ic_launcher.png','ic_launcher_round.png','ic_launcher_foreground.png')) {
    $bmp.Save((Join-Path $dir $name), [System.Drawing.Imaging.ImageFormat]::Png)
  }
  $g.Dispose(); $bmp.Dispose()
}
$bmp = New-Object System.Drawing.Bitmap 192, 192
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.DrawImage($src, 0, 0, 192, 192)
$bmp.Save((Join-Path $ResDir 'ic_launcher.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Save((Join-Path $ResDir 'ic_launcher_round.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose(); $src.Dispose()
Write-Output 'ICONS_OK'