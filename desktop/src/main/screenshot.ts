// GDI screen capture for the jac__screenshot builtin.
//
// Why a PowerShell script and not Electron's desktopCapturer: getSources() hangs
// indefinitely on this Windows/Vulkan setup — the tool call never returns and the chat
// sits "responding" until the MCP timeout fires ten minutes later. CopyFromScreen
// returns in well under a second.
//
// Kept in its own module as a plain template literal so the PowerShell quoting isn't
// fighting TypeScript string escaping.
export const SCREENSHOT_PS1 = String.raw`
param([string]$Out, [string]$Window)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$label = 'full screen'

if ($Window) {
    $p = Get-Process |
         Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle -like "*$Window*" } |
         Select-Object -First 1
    if (-not $p) {
        $open = (Get-Process | Where-Object { $_.MainWindowTitle } |
                 ForEach-Object { $_.MainWindowTitle }) -join ' | '
        Write-Output "no window matching '$Window'. Open windows: $open"
        exit 1
    }
    # Raise it, then grab the screen. Cheaper and far less brittle than P/Invoking
    # GetWindowRect, and the window is what the user is looking at anyway.
    try { $null = (New-Object -ComObject WScript.Shell).AppActivate($p.Id) } catch { }
    Start-Sleep -Milliseconds 600
    $label = $p.MainWindowTitle
}

$b   = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g   = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()

Write-Output "captured $label ($($b.Width)x$($b.Height))"
`;
