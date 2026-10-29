# Starts Claude pet without Node.js: finds or downloads Electron, starts the pet, makes a desktop shortcut.
$ErrorActionPreference = 'Stop'
$ver = '33.4.11'
$app = $PSScriptRoot
$local = Join-Path $app 'electron\electron.exe'
$npm   = Join-Path $app 'node_modules\electron\dist\electron.exe'

if (Test-Path $local)    { $exe = $local }
elseif (Test-Path $npm)  { $exe = $npm }
else {
  Write-Host "First run: downloading the app engine (Electron $ver, about 110 MB). Please wait..."
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $name = "electron-v$ver-win32-x64.zip"
  $urls = @("https://github.com/electron/electron/releases/download/v$ver/$name",
            "https://registry.npmmirror.com/-/binary/electron/v$ver/$name")
  $zip = Join-Path $env:TEMP $name
  $ok = $false
  foreach ($u in $urls) {
    try {
      Write-Host "  from $(([Uri]$u).Host) ..."
      Remove-Item $zip -Force -ErrorAction SilentlyContinue
      (New-Object Net.WebClient).DownloadFile($u, $zip)
      if ((Get-Item $zip).Length -gt 50MB) { $ok = $true; break }
    } catch { Write-Host "  failed: $($_.Exception.Message)" }
  }
  if (-not $ok) { throw 'Could not download Electron. Check the internet connection and run this file again.' }
  Write-Host 'Unpacking...'
  $tmp = Join-Path $app 'electron.tmp'
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  Remove-Item (Join-Path $app 'electron') -Recurse -Force -ErrorAction SilentlyContinue
  Rename-Item $tmp 'electron'
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path $local)) { throw 'electron.exe not found after unpacking.' }
  $exe = $local
}

Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Start-Process -FilePath $exe -ArgumentList ('"' + $app + '"') -WorkingDirectory $app

try {   # desktop shortcut: starts the pet directly, without a console window
  $name = 'Claude ' + [regex]::Unescape('питомец') + '.lnk'
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) $name))
  $s.TargetPath = $exe; $s.Arguments = '"' + $app + '"'; $s.WorkingDirectory = $app
  $s.IconLocation = Join-Path $app 'assets\pet.ico'; $s.Description = 'Claude pet'; $s.Save()
} catch { }
Write-Host 'Claude pet started.'
