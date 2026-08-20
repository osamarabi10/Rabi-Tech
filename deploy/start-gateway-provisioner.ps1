param(
  [switch]$Foreground
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$backendRoot = Join-Path $repoRoot 'apps\backend'
$runtimeRoot = Join-Path $repoRoot '.runtime\gateway-provisioner'
$pidFile = Join-Path $runtimeRoot 'worker.pid'
$stdoutLog = Join-Path $runtimeRoot 'worker.log'
$stderrLog = Join-Path $runtimeRoot 'worker.error.log'

New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null

if (Test-Path $pidFile) {
  $existingPid = [int](Get-Content $pidFile -Raw)
  if (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) {
    Write-Output "RabiTech gateway provisioner is already running (PID $existingPid)."
    exit 0
  }
  Remove-Item -LiteralPath $pidFile -Force
}

if ($Foreground) {
  Push-Location $backendRoot
  try {
    & npm.cmd run gateway:worker
  } finally {
    Pop-Location
  }
  exit $LASTEXITCODE
}

$process = Start-Process `
  -FilePath 'npm.cmd' `
  -ArgumentList @('run', 'gateway:worker') `
  -WorkingDirectory $backendRoot `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -WindowStyle Hidden `
  -PassThru

$process.Id | Set-Content -Path $pidFile -Encoding ascii
Write-Output "RabiTech gateway provisioner started (PID $($process.Id))."
