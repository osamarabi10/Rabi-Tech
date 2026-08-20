import os from 'os';

export function getLanAddresses(): string[] {
  const ips = new Set<string>();
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.add(iface.address);
      }
    }
  }
  return [...ips];
}
