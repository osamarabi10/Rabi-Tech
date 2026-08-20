import { Server } from 'socket.io';
import { Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { corsOriginCallback } from '../utils/cors';
import prisma from '../prisma';
import { runAsOrganization } from '../lib/tenant-context';
import { socketRoom } from './rooms';

let io: Server;

export function initSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    path: '/socket.io',
    addTrailingSlash: false,
    cors: {
      origin: corsOriginCallback,
      credentials: true,
    },
  });

  // Auth middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('No token'));
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
      if (decoded.scope !== 'ORGANIZATION' || !decoded.organizationId) {
        return next(new Error('Organization token required'));
      }
      socket.data.user = decoded;
      socket.data.organizationId = decoded.organizationId;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', async (socket) => {
    const { id, role, primaryTeamId, teamIds = [] } = socket.data.user;
    const organizationId = socket.data.organizationId as string;
    socket.join(socketRoom.organization(organizationId));
    const joinedTeamIds = new Set<string>([primaryTeamId, ...teamIds].filter(Boolean));
    try {
        const userTeams = await runAsOrganization(organizationId, () =>
          role === 'ADMIN'
            ? prisma.team.findMany({ select: { id: true } }).then((teams) =>
                teams.map((team) => ({ teamId: team.id })),
              )
            : prisma.userTeam.findMany({ where: { userId: id }, select: { teamId: true } }),
        );
        for (const team of userTeams) {
          joinedTeamIds.add(team.teamId);
        }
    } catch {
      // Keep the connection alive; explicit room joins below still enforce record access.
    }
    for (const teamId of joinedTeamIds) {
      socket.join(socketRoom.team(organizationId, teamId));
    }
    socket.join(socketRoom.alerts(organizationId));
    // Personal room for per-user notifications
    socket.join(socketRoom.user(organizationId, id));

    // Join specific conversation room when agent opens it
    // SECURITY: Verify user can access this conversation
    socket.on('join_conversation', async (conversationId: string) => {
      if (!conversationId || typeof conversationId !== 'string') {
        socket.emit('error', { message: 'Invalid conversation ID' });
        return;
      }

      try {
        // Look up conversation and verify user's team access
        const conversation = await runAsOrganization(organizationId, () =>
          prisma.conversation.findUnique({
            where: { id: conversationId },
            select: { id: true, teamId: true },
          }),
        );

        if (!conversation) {
          // Don't leak existence — just reject silently
          socket.emit('error', { message: 'Not found' });
          return;
        }

        if (
          role !== 'ADMIN' &&
          !joinedTeamIds.has(conversation.teamId || '')
        ) {
          socket.emit('error', { message: 'Access denied' });
          return;
        }

        socket.join(socketRoom.conversation(organizationId, conversationId));
      } catch (err) {
        socket.emit('error', { message: 'Lookup failed' });
      }
    });

    socket.on('leave_conversation', (conversationId: string) => {
      if (conversationId) socket.leave(socketRoom.conversation(organizationId, conversationId));
    });


    socket.on('disconnect', () => {});
  });

  return io;
}

export function getIO(): Server {
  if (!io) throw new Error('Socket not initialized');
  return io;
}

export const SocketEvents = {
  NEW_MESSAGE:           'new_message',
  NEW_CONVERSATION:      'new_conversation',
  CONVERSATION_RESOLVED: 'conversation_resolved',
  UNREAD_UPDATE:         'unread_update',
  TICKET_UPDATED:        'ticket_updated',
  CAMPAIGN_PROGRESS:     'campaign_progress',
  ALERT_NEW:             'alert_new',
  SESSION_STATUS:        'session_status',
  GROUP_MESSAGE:         'group_message',
  MESSAGE_ACK:           'message_ack',
  NOTIFICATION:          'notification',
} as const;
