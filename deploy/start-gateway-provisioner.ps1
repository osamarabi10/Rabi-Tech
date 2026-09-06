# SUPERSEDED 2026-09-06 — do not run this alongside the compose service.
#
# The gateway provisioning worker is now the `gateway-worker` service in
# docker-compose.yml, with `restart: always`. That service is what supervises
# the worker; these scripts were the earlier attempt at the same thing.
#
# Running both is actively harmful, not merely redundant: they consume the same
# BullMQ queue and will race for jobs. This launcher also starts the worker via
# `npm run gateway:worker`, which is ts-node — roughly 390 MB resident, and the
# configuration that was OOM-killed twice on 2026-09-05.
#
# To run the worker on the host deliberately (debugging, or no socket to spare),
# stop the service first and use the compiled entry point:
#
#   docker compose stop gateway-worker
#   cd apps/backend
#   GATEWAY_HOST_ACCESS=127.0.0.1 node -r ./scripts/load-env \
#     dist/workers/gateway-provisioning.worker.js
#
# GATEWAY_HOST_ACCESS matters: the code default is now host.docker.internal,
# which is correct in a container and wrong on the host. See D-13, D-14 and
# docs/DEPLOYMENT.md.

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
