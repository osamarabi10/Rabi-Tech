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
# This one additionally registers a logon-triggered scheduled task, so it would
# resurrect the competing worker on every sign-in. It is not registered on this
# machine (checked 2026-09-06).

$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot 'start-gateway-provisioner.ps1'
$taskName = 'RabiTech Gateway Provisioner'
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RestartCount 5 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description 'Runs the RabiTech host-side OpenWA provisioning worker.' `
  -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
Write-Output "Installed and started scheduled task: $taskName"
