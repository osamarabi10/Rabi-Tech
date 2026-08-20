import type { OrganizationConfig } from '@prisma/client';
import { getTenantCache, getTenantId } from '../lib/tenant-context';
import { prisma } from '../prisma';

const CONFIG_CACHE_KEY = 'organization-inbox-config';
const ORGANIZATION_CONFIG_CACHE_KEY = 'organization-config';

export async function getPrimarySession() {
  const organizationId = getTenantId();
  return prisma.whatsappSession.findFirst({
    where: { organizationId, isActive: true },
    orderBy: { createdAt: 'asc' },
  });
}

export async function getSessionForTeam(teamId?: string | null) {
  const organizationId = getTenantId();
  if (teamId) {
    const teamSession = await prisma.whatsappSession.findFirst({
      where: { organizationId, teamId, isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    if (teamSession) return teamSession;
  }
  return getPrimarySession();
}

export async function getInboxConfig() {
  const organizationId = getTenantId();
  const cache = getTenantCache();
  const cached = cache.get(CONFIG_CACHE_KEY);
  if (cached) return cached;

  const sessions = await prisma.whatsappSession.findMany({
    where: { organizationId, isActive: true },
    select: {
      id: true,
      sessionName: true,
      label: true,
      phoneNumber: true,
      teamId: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  const value = { sessions };
  cache.set(CONFIG_CACHE_KEY, value);
  return value;
}

export async function getOrganizationConfig(_organizationId?: string) {
  const organizationId = getTenantId();
  const cache = getTenantCache();
  const cached = cache.get(ORGANIZATION_CONFIG_CACHE_KEY) as OrganizationConfig | undefined;
  if (cached) return cached;

  const config = await prisma.organizationConfig.findUnique({ where: { organizationId } });
  if (!config) {
    throw new Error(`Organization config not found for ${organizationId}`);
  }

  cache.set(ORGANIZATION_CONFIG_CACHE_KEY, config);
  return config;
}

export function invalidateOrganizationConfig(): void {
  getTenantCache().delete(CONFIG_CACHE_KEY);
  getTenantCache().delete(ORGANIZATION_CONFIG_CACHE_KEY);
}

export async function inboxConfig(_organizationId: string) {
  return getInboxConfig();
}
