param([string]$ExtraStop = '', [string]$ExtraAllow = '', [switch]$Dump)
# Watches the Claude desktop app through Windows UI Automation (no flags, no setup).
# Prints a line only when the state changes: thinking | waiting | idle | none
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

# Whole button names only: a chat title like "Stop the server" must not count as a Stop button.
# The file stays ASCII (Windows PowerShell 5 reads it in the ANSI code page), so Russian names are escaped.
$ostanovit = (-join [char[]](0x041E,0x0441,0x0442,0x0430,0x043D,0x043E,0x0432,0x0438,0x0442,0x044C))
$otvet = (-join [char[]](0x043E,0x0442,0x0432,0x0435,0x0442))
$razreshit = (-join [char[]](0x0420,0x0430,0x0437,0x0440,0x0435,0x0448,0x0438,0x0442,0x044C))
$stopNames  = @('Stop', 'Stop response', 'Stop generating', $ostanovit, "$ostanovit $otvet")
$allowNames = @('Allow', 'Approve', $razreshit)
$stopRe  = '^(' + (($stopNames | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')$'
$allowRe = '^(' + (($allowNames | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')(\s.{0,24})?$'
if ($ExtraStop -ne '')  { $stopRe  = '(' + $stopRe  + ')|^(' + $ExtraStop  + ')' }
if ($ExtraAllow -ne '') { $allowRe = '(' + $allowRe + ')|^(' + $ExtraAllow + ')' }

$AE = [System.Windows.Automation.AutomationElement]
$buttons = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
$cache = New-Object System.Windows.Automation.CacheRequest
$cache.Add($AE::NameProperty)
$cache.TreeScope = [System.Windows.Automation.TreeScope]::Element

$last = ''
while ($true) {
  $state = 'none'
  # The console "claude.exe" from Claude Code is not the app: filter it out by path.
  $procs = Get-Process -Name Claude -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -notlike '*\.local\*' -and $_.Path -notlike '*\.claude\*' }
  foreach ($p in $procs) {
    try {
      $root = $AE::FromHandle($p.MainWindowHandle)
      $scope = $cache.Activate()
      try { $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttons) } finally { $scope.Dispose() }
      if ($Dump) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; foreach ($e in $all) { if ($e.Cached.Name) { Write-Output $e.Cached.Name } }; $dumped = $true; continue }
      $busy = $false; $ask = $false
      foreach ($e in $all) {
        $n = $e.Cached.Name
        if ($n -match $stopRe)  { $busy = $true }
        if ($n -match $allowRe) { $ask = $true }
      }
      if ($ask) { $state = 'waiting' } elseif ($busy -and $state -ne 'waiting') { $state = 'thinking' } elseif ($state -eq 'none') { $state = 'idle' }
    } catch { if ($state -eq 'none') { $state = 'idle' } }
  }
  if ($Dump) { if (-not $dumped) { Write-Output '__no_window__' }; exit 0 }
  if ($state -ne $last) { Write-Output $state; [Console]::Out.Flush(); $last = $state }
  Start-Sleep -Milliseconds 600
}
