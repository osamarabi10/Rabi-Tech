import { PrismaClient } from '@prisma/client';
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
async function main() {
  console.log('Seeding RabiTech database...');

  const organizationId = 'org_rabitech_0';
  await prisma.organization.upsert({
    where: { id: organizationId },
    update: { name: 'RabiTech Demo', slug: 'rabitech-demo', status: 'ACTIVE' },
    create: { id: organizationId, name: 'RabiTech Demo', slug: 'rabitech-demo', status: 'ACTIVE' },
  });

  const ownerEmail = (process.env.PLATFORM_OWNER_EMAIL || 'owner@rabitech.co.il').toLowerCase();
  const ownerHash = await bcrypt.hash(process.env.PLATFORM_OWNER_PASSWORD || 'owner12345', 10);
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
  const adminHash = await bcrypt.hash('admin123', 10);
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
  const agentHash = await bcrypt.hash('rabitech2026', 10);
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
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
