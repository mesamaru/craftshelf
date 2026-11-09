# CraftShelf のタスクトレイのアイコン(Windows。launcher.mjs が窓を出さずに起動する。v02 の launcher.py の pystray と同じメニュー)。
# 「終了」を選んだら標準出力に quit と書いて終わる(launcher.mjs がパネルを止める)。launcher.mjs が終わったら、これも終わる。
# Windows PowerShell 5.1 が日本語を読めるよう、このファイルは BOM 付きの UTF-8 で置く
param([string]$Url, [string]$DataDir, [string]$Icon, [int]$ParentPid)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$tray = New-Object System.Windows.Forms.NotifyIcon
try {
  $tray.Icon = [System.Drawing.Icon]::FromHandle((New-Object System.Drawing.Bitmap ([System.Drawing.Image]::FromFile($Icon)), 32, 32).GetHicon())
} catch {
  $tray.Icon = [System.Drawing.SystemIcons]::Application
}
$tray.Text = "CraftShelf"

$quit = {
  [Console]::Out.WriteLine("quit")
  [Console]::Out.Flush()
  $tray.Visible = $false
  [System.Windows.Forms.Application]::Exit()
}
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add("CraftShelf を開く", $null, { Start-Process $Url })
$open.Font = New-Object System.Drawing.Font($open.Font, [System.Drawing.FontStyle]::Bold)
[void]$menu.Items.Add("保存先フォルダを開く", $null, { Invoke-Item -LiteralPath $DataDir })
[void]$menu.Items.Add("-")
[void]$menu.Items.Add("終了", $null, $quit)
$tray.ContextMenuStrip = $menu
# 左クリックでも開く(v02 と同じ)
$tray.add_MouseClick({ param($s, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Start-Process $Url } })
$tray.Visible = $true

# launcher.mjs が終わっていたら(窓を閉じた・落ちた)、アイコンを片付けて終わる
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
  if ($ParentPid -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
    $tray.Visible = $false
    [System.Windows.Forms.Application]::Exit()
  }
})
$timer.Start()
[System.Windows.Forms.Application]::Run()
$tray.Dispose()
