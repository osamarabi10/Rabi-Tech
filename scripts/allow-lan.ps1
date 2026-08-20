# Allow the RabiTech dashboard on the local network (router Wi-Fi)
$rules = @(
  @{ Name = 'RabiTech Frontend'; Port = 8080 },
  @{ Name = 'RabiTech Backend'; Port = 4000 }
)

foreach ($r in $rules) {
  $existing = Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "Firewall rule already exists: $($r.Name)"
    continue
  }
  New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -LocalPort $r.Port -Protocol TCP -Action Allow | Out-Null
  Write-Host "Allowed TCP $($r.Port) - $($r.Name)"
}

$ips = Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
  $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown'
} | Select-Object -ExpandProperty IPAddress

Write-Host ""
Write-Host "Open from phone or another PC on same Wi-Fi:"
foreach ($ip in $ips) {
  Write-Host ('  http://' + $ip + ':8080')
}
