import { Router } from 'express';
import { prisma } from '../../prisma';
import logger from '../../lib/logger';
import { requireScope } from '../api-tokens/api-token.middleware';

/**
 * Discovery — the vocabulary of one organization.
 *
 * ## Why these are not optional extras
 *
 * Every write endpoint on this API takes values a caller cannot invent. Setting
 * `lifecycleStage` means knowing which stages exist; sending `customFields`
 * means knowing the slugs; assigning a conversation means knowing user ids.
 *
 * Without these, an integrator discovers the organization's vocabulary by guessing
 * and reading 400s — which is how integrations end up hardcoding a stage name
 * that one organization happens to use, and silently failing on every other one.
 * `PATCH /contacts` names the valid slugs when you get one wrong; that is a
 * safety net, not a way to find out.
 *
 * All read-only, all `workspace:read` except tags.
 */

const router = Router();

function fail(res: any, req: any, err: unknown, where: string) {
  logger.error(`public-api ${where} failed`, { error: (err as Error)?.message, requestId: req.id });
  return res.status(500).json({ error: 'server_error' });
}

/**
 * `GET /tags` — the organization's tag vocabulary.
 *
 * This endpoint is also the fix for a defect in this API's own first release:
 * `tags:read` was a scope a subscriber could grant and **nothing required it**.
 * A ticked box that gates nothing is the shape this repository has now shipped
 * six times, and that time it was ours.
 */
router.get('/tags', requireScope('tags:read'), async (req, res) => {
  try {
    const tags = await prisma.tag.findMany({
      select: { id: true, name: true, colorCode: true, description: true },
      orderBy: { name: 'asc' },
      take: 500,
    });
    return res.json({ tags });
  } catch (err) { return fail(res, req, err, 'GET /tags'); }
});

/**
 * `GET /contact-fields` — the custom field definitions.
 *
 * Returns the slug, the type and the allowed values, which together are what a
 * caller needs to send a value that will pass validation rather than one that
 * will 400.
 */
router.get('/contact-fields', requireScope('workspace:read'), async (req, res) => {
  try {
    const fields = await prisma.customFieldDefinition.findMany({
      select: { id: true, slug: true, name: true, dataType: true, allowedValues: true },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    return res.json({ fields });
  } catch (err) { return fail(res, req, err, 'GET /contact-fields'); }
});

/**
 * `GET /lifecycle-stages` — the stages, in the order the organization arranged them.
 *
 * Ordered by `orderIndex`, not by name: a lifecycle is a sequence, and
 * alphabetical would put Customer before Lead. `kind` matters to a caller —
 * ACTIVE stages form the funnel, LOST stages record why someone dropped out, and
 * an integration advancing a contact must not walk into a LOST stage by
 * iterating the list.
 */
router.get('/lifecycle-stages', requireScope('workspace:read'), async (req, res) => {
  try {
    const stages = await prisma.lifecycleStage.findMany({
      select: { id: true, name: true, kind: true, isDefault: true, isWon: true, orderIndex: true },
      orderBy: [{ kind: 'asc' }, { orderIndex: 'asc' }],
      take: 50,
    });
    return res.json({ stages });
  } catch (err) { return fail(res, req, err, 'GET /lifecycle-stages'); }
});

/**
 * `GET /users` — who can be assigned a conversation.
 *
 * Email is included because it is how an integrator matches a RabiTech user to
 * the same person in their own system; without it they match on display name,
 * which two people can share. Deactivated users are excluded: assigning to one
 * would be accepted by the database and seen by nobody.
 */
router.get('/users', requireScope('workspace:read'), async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { isActive: true },
      // Email lives on Identity, not User — one identity can hold a seat in
      // several organizations, and the login address belongs to the person rather
      // than to any one membership.
      select: { id: true, name: true, role: true, identity: { select: { email: true } } },
      orderBy: { name: 'asc' },
      take: 500,
    });
    return res.json({
      users: users.map((user) => ({
        id: user.id,
        name: user.name,
        role: user.role,
        email: user.identity?.email ?? null,
      })),
    });
  } catch (err) { return fail(res, req, err, 'GET /users'); }
});

/** `GET /teams` — for routing a conversation to a group rather than a person. */
router.get('/teams', requireScope('workspace:read'), async (req, res) => {
  try {
    const teams = await prisma.team.findMany({
      select: { id: true, name: true, slug: true },
      orderBy: { name: 'asc' },
      take: 200,
    });
    return res.json({ teams });
  } catch (err) { return fail(res, req, err, 'GET /teams'); }
});

export default router;
