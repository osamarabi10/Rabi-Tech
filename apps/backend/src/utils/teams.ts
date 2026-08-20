import { prisma } from '../prisma';

export async function findDefaultTeam() {
  return prisma.team.findFirst({
    where: { isDefault: true },
    select: { id: true, name: true, slug: true, color: true, isDefault: true },
    orderBy: { createdAt: 'asc' },
  });
}

export async function resolveTeamId(input?: { teamId?: string | null }) {
  if (input?.teamId) {
    const team = await prisma.team.findUnique({
      where: { id: input.teamId },
      select: { id: true },
    });
    if (team) return team.id;
  }

  const defaultTeam = await findDefaultTeam();
  return defaultTeam?.id || null;
}

export async function requireTeamId(input?: { teamId?: string | null }) {
  const teamId = await resolveTeamId(input);
  if (!teamId) throw new Error('No team is configured for organization');
  return teamId;
}
