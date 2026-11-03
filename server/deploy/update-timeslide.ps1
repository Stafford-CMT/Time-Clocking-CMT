# Updates the live Time Slide on CMTDC01 from an update folder made by
# `npm run make-update` on a development PC. Run it on the server, in
# PowerShell as administrator:
#
#   powershell -ExecutionPolicy Bypass -File "C:\TIME SLIDE\update\update-timeslide.ps1"
#
# It backs up the running app, copies the new files in (never the server's
# .env or logs), installs packages only if they changed, applies database
# migrations, restarts the TimeSlideApp service and checks it is answering.
# If any step fails it puts the backup back and restarts, so the live site is
# never left half-updated.

param(
  [string]$Zip = (Join-Path $PSScriptRoot 'time-slide-app.zip')
)
$ErrorActionPreference = 'Stop'
$Live = 'C:\TIME SLIDE\server'
$Service = 'TimeSlideApp'
$Stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$Backup = "C:\TIME SLIDE\backups\$Stamp"
$Unpacked = Join-Path $PSScriptRoot '_unpacked'
$MovedModules = $false

function Say($text) { Write-Host "  $text" }
function Step($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }

# robocopy: exit codes 0-7 mean success, 8 and above mean failure.
function Copy-Tree($from, $to, [string[]]$extra) {
  $rcArgs = @($from, $to, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:2', '/W:2') + $extra
  & robocopy @rcArgs | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "copying $from to $to failed (robocopy code $LASTEXITCODE)" }
}

function Restore-Backup {
  Write-Host ''
  Write-Host '!! Putting the previous version back...' -ForegroundColor Yellow
  Copy-Tree $Backup $Live @('/XD', 'node_modules')
  if ($MovedModules -and (Test-Path (Join-Path $Backup 'node_modules'))) {
    if (Test-Path (Join-Path $Live 'node_modules')) { Remove-Item (Join-Path $Live 'node_modules') -Recurse -Force }
    Move-Item (Join-Path $Backup 'node_modules') (Join-Path $Live 'node_modules')
  }
  Restart-Service $Service
  Start-Sleep -Seconds 5
  Say "Previous version restored; $Service is $((Get-Service $Service).Status)."
}

function Test-Running($logLinesBefore) {
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 1
    $log = Join-Path $Live 'logs\service-out.log'
    $new = @(Get-Content $log -ErrorAction SilentlyContinue | Select-Object -Skip $logLinesBefore)
    if ($new -match 'Time Slide server running on') {
      $status = try { (Invoke-WebRequest 'http://127.0.0.1:4004/login.html' -UseBasicParsing -TimeoutSec 10).StatusCode } catch { 0 }
      if ((Get-Service $Service).Status -eq 'Running' -and $status -eq 200) { return $true }
    }
  }
  return $false
}

Write-Host ''
Write-Host 'Time Slide update' -ForegroundColor Cyan
if ($env:COMPUTERNAME -ne 'CMT-DC') { Write-Host "STOPPED: this is $env:COMPUTERNAME, not the server CMT-DC. Nothing was changed." -ForegroundColor Red; exit 1 }
if (-not (Test-Path $Zip)) { Write-Host "STOPPED: $Zip not found. Nothing was changed." -ForegroundColor Red; exit 1 }
if (-not (Test-Path (Join-Path $Live '.env'))) { Write-Host "STOPPED: $Live\.env not found - is Time Slide installed here? Nothing was changed." -ForegroundColor Red; exit 1 }

try {
  Step 'Unpacking the update'
  if (Test-Path $Unpacked) { Remove-Item $Unpacked -Recurse -Force }
  Expand-Archive $Zip -DestinationPath $Unpacked -Force
  $New = Join-Path $Unpacked 'server'
  if (-not (Test-Path (Join-Path $New 'src\index.js'))) { throw 'the zip does not contain server\src\index.js' }
  $version = if (Test-Path (Join-Path $New 'VERSION.txt')) { (Get-Content (Join-Path $New 'VERSION.txt') -TotalCount 1) } else { 'unknown version' }
  Say "Update: $version"
  $oldVersion = if (Test-Path (Join-Path $Live 'VERSION.txt')) { (Get-Content (Join-Path $Live 'VERSION.txt') -TotalCount 1) } else { 'the first deployment' }
  Say "Running now: $oldVersion"

  Step "Backing up the running app to $Backup"
  New-Item -ItemType Directory -Force $Backup | Out-Null
  Copy-Tree $Live $Backup @('/XD', 'node_modules', 'logs')
  Say 'Backed up (packages and logs are left in place).'
} catch {
  Write-Host ''
  Write-Host "STOPPED before changing anything: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

try {
  $packagesChanged = (Get-FileHash (Join-Path $New 'package-lock.json')).Hash -ne (Get-FileHash (Join-Path $Live 'package-lock.json')).Hash

  Step 'Copying the new files in (the server .env and logs are kept)'
  Copy-Tree $New $Live @('/XF', '.env', '/XD', 'logs', 'node_modules')
  Say 'Copied.'

  if ($packagesChanged) {
    Step 'Packages changed: installing them (npm ci)'
    Move-Item (Join-Path $Live 'node_modules') (Join-Path $Backup 'node_modules')
    $MovedModules = $true
    Push-Location $Live
    & npm ci --omit=dev --no-audit --no-fund
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { throw "npm ci failed (code $code)" }
  } else {
    Step 'Packages unchanged: no install needed'
  }

  Step 'Database migrations'
  Push-Location $Live
  & npm run migrate --silent
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { throw "npm run migrate failed (code $code)" }

  Step "Restarting $Service"
  $logLinesBefore = @(Get-Content (Join-Path $Live 'logs\service-out.log') -ErrorAction SilentlyContinue).Count
  Restart-Service $Service
  if (-not (Test-Running $logLinesBefore)) {
    $errors = Get-Content (Join-Path $Live 'logs\service-error.log') -Tail 15 -ErrorAction SilentlyContinue
    throw ("Time Slide did not come back up after the restart. Last lines of service-error.log:`n" + ($errors -join "`n"))
  }

  Write-Host ''
  Write-Host "[OK] Time Slide updated to: $version" -ForegroundColor Green
  Say 'Service running, log shows it started, https site answering on port 4004.'
  Say "Backup kept in $Backup (delete it after a few days)."
  Say 'Refresh the browser with Ctrl+F5 to load the new page.'
  Remove-Item $Unpacked -Recurse -Force -ErrorAction SilentlyContinue
  exit 0
} catch {
  Write-Host ''
  Write-Host "[FAILED] $($_.Exception.Message)" -ForegroundColor Red
  try { Restore-Backup } catch { Write-Host "Could not restore automatically: $($_.Exception.Message). The backup is in $Backup." -ForegroundColor Red }
  Write-Host 'Nothing else needs doing now. Paste this whole window to Claude.' -ForegroundColor Yellow
  exit 1
}
