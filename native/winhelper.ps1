# Long-lived helper: reads one command per line on stdin, writes one JSON line per command on stdout.
# Commands: poll | screenshot <path> <maxWidth> | sysinfo | ping
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class MaiWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO l);
  public static string Title() { var h = GetForegroundWindow(); var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  public static uint Pid() { uint p; GetWindowThreadProcessId(GetForegroundWindow(), out p); return p; }
  public static uint IdleMs() { var l = new LASTINPUTINFO(); l.cbSize = (uint)Marshal.SizeOf(l); GetLastInputInfo(ref l); return (uint)Environment.TickCount - l.dwTime; }
}
"@

function Out-Json($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush() }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Trim().Split(" ", 3)
  try {
    switch ($parts[0]) {
      "ping" { Out-Json @{ ok = $true } }
      "poll" {
        $procName = ""
        try { $procName = (Get-Process -Id ([MaiWin]::Pid())).ProcessName } catch {}
        Out-Json @{ ok = $true; title = [MaiWin]::Title(); process = $procName; idleMs = [MaiWin]::IdleMs() }
      }
      "screenshot" {
        $path = $parts[1]; $maxW = [int]$parts[2]
        $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
        $scale = [Math]::Min(1.0, $maxW / $b.Width)
        $w = [int]($b.Width * $scale); $h = [int]($b.Height * $scale)
        $small = New-Object System.Drawing.Bitmap $bmp, $w, $h
        $small.Save($path, [System.Drawing.Imaging.ImageFormat]::Jpeg)
        $g.Dispose(); $bmp.Dispose(); $small.Dispose()
        Out-Json @{ ok = $true; path = $path; width = $w; height = $h }
      }
      "sysinfo" {
        $os = Get-CimInstance Win32_OperatingSystem
        $cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name
        $disks = Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } | ForEach-Object { @{ name = $_.Name; freeGB = [Math]::Round($_.Free / 1GB, 1); usedGB = [Math]::Round($_.Used / 1GB, 1) } }
        $uptimeH = [Math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)
        $batt = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
        Out-Json @{ ok = $true; os = $os.Caption; cpu = $cpu; uptimeHours = $uptimeH; disks = @($disks); batteryPct = $(if ($batt) { $batt.EstimatedChargeRemaining } else { $null }) }
      }
      default { Out-Json @{ ok = $false; error = "unknown command" } }
    }
  } catch {
    Out-Json @{ ok = $false; error = $_.Exception.Message }
  }
}
