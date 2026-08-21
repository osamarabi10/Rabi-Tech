import { prisma } from '../../prisma';
import { campaignIdsInFilter, type ContactFilterDsl } from '../../lib/contact-filter-dsl';

/**
 * Campaign ids referenced by a contact filter, checked against the caller's
 * organization.
 *
 * Extracted from `campaigns.routes.ts` because saved segments need the same
 * rule: two copies of "this campaign must belong to my org" will drift, and
 * this is the guard that stops a cross-tenant campaign probe.
 *
 * Every query here runs inside the tenant scope, so `prisma.campaign` is already
 * filtered to the caller's organization by the tenancy extension.
 */

/** Referenced ids that do not resolve inside the caller's organization. */
export async function missingCampaignIds(filter: ContactFilterDsl | null): Promise<string[]> {
  const ids = campaignIdsInFilter(filter);
  if (!ids.length) return [];
  const found = await prisma.campaign.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  });
  const seen = new Set(found.map((campaign) => campaign.id));
  return ids.filter((id) => !seen.has(id));
}

/**
 * Throws a 404-shaped error when any referenced campaign is missing.
 *
 * Unvalidated a foreign id already fails safe — the nested filter carries
 * organizationId, so another tenant's campaign simply matches nobody. But "0
 * recipients" is an answer, and returning it for a probed id confirms nothing
 * exists there while a real id would eventually return a number. 404 for both,
 * matching the convention that existence is itself information.
 */
export async function assertCampaignsInOrg(filter: ContactFilterDsl | null): Promise<void> {
  const missing = await missingCampaignIds(filter);
  if (!missing.length) return;
  const error = new Error('حملة غير موجودة');
  (error as Error & { statusCode?: number }).statusCode = 404;
  throw error;
}
