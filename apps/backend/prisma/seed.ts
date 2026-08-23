import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { seedDefaultAutoReplies } from '../src/utils/seed-auto-replies';

const prisma = new PrismaClient();

/**
 * Local/demo bootstrap data — NOT a production fixture.
 *
 * Creates one demo subscriber ("rabitech-demo") with a couple of teams, a
 * generic WhatsApp session, an admin, a few agents, and the platform's default
 * (editable, white-label-safe) auto-replies. Nothing here should carry a real
 * business's branding, phone numbers, or industry-specific copy — see
 * constants/default-auto-replies.ts for why.
 */
/**
 * Passwords the seed had hardcoded.
 *
 * `owner12345` and `admin123` were compiled into this file and printed in a
 * public README. A default credential published in a public repository is a
 * credential, not a placeholder — anyone who read the front page could sign
 * in to any instance nobody had thought to change.
 *
 * So there is no fallback constant any more. Set the variable and it is used;
 * leave it unset and one is generated, printed **once**, and never written
 * down anywhere. Making the quick start throw instead would have been safer
 * still and would also have made the first five minutes of this project a
 * configuration error, which is how people end up committing a password to
 * make it stop.
 */
const generated: Array<{ label: string; password: string }> = [];

function passwordFor(envVar: string, label: string): string {
  const configured = process.env[envVar];
  if (configured && configured.trim()) return configured;
  // 24 bytes of base64url: long enough that nobody is tempted to keep it.
  const password = crypto.randomBytes(18).toString('base64url');
  generated.push({ label: `${label} (${envVar})`, password });
  return password;
}

/** Printed once, at the end, where it will not scroll past unread. */
function reportGenerated(): void {
  if (generated.length === 0) return;
  console.log('');
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log('  GENERATED PASSWORDS — copy them now, they are not stored');
  console.log('  ─────────────────────────────────────────────────────────────');
  for (const entry of generated) {
    console.log(`  ${entry.label}`);
    console.log(`    ${entry.password}`);
  }
  console.log('');
  console.log('  Set these in .env to choose your own instead.');
  console.log('  See docs/SECURITY-ROTATION.md');
  console.log('');
}

async function main() {
  console.log('Seeding RabiTech database...');

  const organizationId = 'org_rabitech_0';
  await prisma.organization.upsert({
    where: { id: organizationId },
    update: { name: 'RabiTech Demo', slug: 'rabitech-demo', status: 'ACTIVE' },
    create: { id: organizationId, name: 'RabiTech Demo', slug: 'rabitech-demo', status: 'ACTIVE' },
  });

  const ownerEmail = (process.env.PLATFORM_OWNER_EMAIL || 'owner@rabitech.co.il').toLowerCase();
  const ownerPassword = passwordFor('PLATFORM_OWNER_PASSWORD', ownerEmail);
  const ownerHash = await bcrypt.hash(ownerPassword, 10);
  await prisma.identity.upsert({
    where: { email: ownerEmail },
    update: { passwordHash: ownerHash, platformRole: 'OWNER' },
    create: { email: ownerEmail, passwordHash: ownerHash, platformRole: 'OWNER' },
  });

  // Teams — generic roles, no industry-specific naming. Upsert matches an
  // existing team by slug and returns *its* id, which will not be the literal
  // string below if this org was seeded before — so every later reference to a
  // team uses the id upsert actually returned, never an assumed constant.
  const teamSeeds = [
    { id: 'team-demo-admin',   name: 'Administration', slug: 'admin',   color: '#475569', isDefault: false },
    { id: 'team-demo-support', name: 'Support',        slug: 'support', color: '#2563EB', isDefault: true },
    { id: 'team-demo-sales',   name: 'Sales',           slug: 'sales',   color: '#DB2777', isDefault: false },
  ];
  const teamIdBySlug: Record<string, string> = {};
  for (const t of teamSeeds) {
    const team = await prisma.team.upsert({
      where: { organizationId_slug: { organizationId, slug: t.slug } },
      update: { name: t.name, color: t.color },
      create: { id: t.id, organizationId, name: t.name, slug: t.slug, color: t.color, isDefault: t.isDefault },
    });
    teamIdBySlug[t.slug] = team.id;
  }

  // One demo WhatsApp session on the Support team, deliberately unlinked.
  //
  // A freshly seeded session starts with no phone number — the admin links a
  // real one by scanning its own QR code. Pre-filling this from IT_NUMBER (a
  // leftover single-tenant env var) would silently attach someone else's
  // WhatsApp number to a brand-new demo organization.
  await prisma.whatsappSession.upsert({
    where: { organizationId_sessionName: { organizationId, sessionName: 'rabitech-demo-primary' } },
    update: { label: 'الدعم', isActive: true, teamId: teamIdBySlug.support },
    create: {
      organizationId,
      sessionName: 'rabitech-demo-primary',
      teamId: teamIdBySlug.support,
      label: 'الدعم',
    },
  });

  // Admin user
  const adminPassword = passwordFor('SEED_ADMIN_PASSWORD', 'admin@rabitech.co.il');
  const adminHash = await bcrypt.hash(adminPassword, 10);
  const adminIdentity = await prisma.identity.upsert({
    where: { email: 'admin@rabitech.co.il' },
    update: { passwordHash: adminHash },
    create: { email: 'admin@rabitech.co.il', passwordHash: adminHash },
  });
  await prisma.user.upsert({
    where: { organizationId_identityId: { organizationId, identityId: adminIdentity.id } },
    update: { role: 'ADMIN', primaryTeamId: teamIdBySlug.admin },
    create: {
      organizationId,
      identityId: adminIdentity.id,
      name: 'مدير النظام',
      role: 'ADMIN',
      primaryTeamId: teamIdBySlug.admin,
    },
  });

  // A few demo agents split across Support and Sales.
  const agentPassword = passwordFor('SEED_AGENT_PASSWORD', 'the seeded agents');
  const agentHash = await bcrypt.hash(agentPassword, 10);
  const agents = [
    { name: 'أحمد صالح',   email: 'ahmed@rabitech.co.il',    phone: '0501234567', teamId: teamIdBySlug.support },
    { name: 'محمد علي',    email: 'mohammed@rabitech.co.il', phone: '0502345678', teamId: teamIdBySlug.support },
    { name: 'يوسف كريم',   email: 'yousef@rabitech.co.il',   phone: '0503456789', teamId: teamIdBySlug.support },
    { name: 'فريق المبيعات', email: 'sales@rabitech.co.il',   phone: '0504567890', teamId: teamIdBySlug.sales },
  ];
  for (const a of agents) {
    const identity = await prisma.identity.upsert({
      where: { email: a.email },
      update: { passwordHash: agentHash },
      create: { email: a.email, passwordHash: agentHash },
    });
    await prisma.user.upsert({
      where: { organizationId_identityId: { organizationId, identityId: identity.id } },
      update: { primaryTeamId: a.teamId },
      create: {
        organizationId,
        identityId: identity.id,
        name: a.name,
        phone: a.phone,
        role: 'AGENT',
        primaryTeamId: a.teamId,
      },
    });
  }

  // Auto-replies: the platform's own starter set, editable per-organization,
  // never platform-branded. See constants/default-auto-replies.ts.
  await prisma.$transaction((tx) => seedDefaultAutoReplies(tx, organizationId));

  // Working hours, pointed at the OUT_OF_HOURS auto-reply we just seeded.
  const oohTemplate = await prisma.messageTemplate.findFirst({
    where: { organizationId, autoReplyKind: 'OUT_OF_HOURS' },
    select: { id: true },
  });
  await prisma.workingHours.upsert({
    where: { organizationId },
    update: { outOfHoursTemplateId: oohTemplate?.id },
    create: {
      organizationId,
      enabled: true,
      timezone: 'Asia/Jerusalem',
      workDays: [0, 1, 2, 3, 4],
      startTime: '08:00',
      endTime: '20:00',
      outOfHoursTemplateId: oohTemplate?.id,
    },
  });

  console.log('Seed complete!');
  // Last, so anything generated is the final thing on screen rather than
  // scrolled past under a wall of progress lines.
  reportGenerated();
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
