param(
    [string]$FontFile = 'Inter-variable.ttf',
    [string]$Text = 'A little insight. A lot to talk about.',
    [string]$Output = 'tagline.json'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$fonts = [System.Drawing.Text.PrivateFontCollection]::new()
$fonts.AddFontFile((Join-Path $PSScriptRoot $FontFile))
$path = [System.Drawing.Drawing2D.GraphicsPath]::new()
$path.AddString($Text, $fonts.Families[0], 0, 100, [System.Drawing.PointF]::new(0, 0), [System.Drawing.StringFormat]::GenericTypographic)
$bounds = $path.GetBounds()
$points = $path.PathPoints
$types = $path.PathTypes
$culture = [System.Globalization.CultureInfo]::InvariantCulture
function PointText($point) {
    (($point.X - $bounds.X).ToString('0.###', $culture)) + ' ' + (($point.Y - $bounds.Y).ToString('0.###', $culture))
}
$parts = [System.Collections.Generic.List[string]]::new()
for ($i = 0; $i -lt $points.Length; $i++) {
    switch ($types[$i] -band 7) {
        0 { $parts.Add('M' + (PointText $points[$i])) }
        1 { $parts.Add('L' + (PointText $points[$i])) }
        3 {
            $parts.Add('C' + (PointText $points[$i]) + ' ' + (PointText $points[$i + 1]) + ' ' + (PointText $points[$i + 2]))
            $i += 2
        }
    }
    if ($types[$i] -band 128) { $parts.Add('Z') }
}
@{
    text = $Text
    font = $fonts.Families[0].Name
    width = $bounds.Width
    height = $bounds.Height
    path = $parts -join ' '
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot $Output) -Encoding utf8
$path.Dispose()
$fonts.Dispose()
