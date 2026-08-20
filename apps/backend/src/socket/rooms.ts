function requireRoomPart(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required for socket room`);
  return normalized;
}

function organizationPrefix(organizationId: string): string {
  return `org:${requireRoomPart(organizationId, 'organizationId')}`;
}

export const socketRoom = {
  organization: (organizationId: string) => organizationPrefix(organizationId),
  team: (organizationId: string, teamId: string) =>
    `${organizationPrefix(organizationId)}:team:${requireRoomPart(teamId, 'teamId')}`,
  alerts: (organizationId: string) => `${organizationPrefix(organizationId)}:alerts`,
  user: (organizationId: string, userId: string) =>
    `${organizationPrefix(organizationId)}:user:${requireRoomPart(userId, 'userId')}`,
  conversation: (organizationId: string, conversationId: string) =>
    `${organizationPrefix(organizationId)}:conv:${requireRoomPart(conversationId, 'conversationId')}`,
} as const;
