/**
 * One-off / re-runnable sync: pull group messages from OpenWA's message store
 * into our GroupMessage table. Idempotent via waMessageId — safe to run again.
 *
 * Usage: npx ts-node --transpile-only scripts/backfill-group-messages.ts
 */
import 'dotenv/config';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { normalizeGroupId } from '../src/utils/group-id';

const prisma = new PrismaClient();
const openwa = axios.create({
  baseURL: process.env.OPENWA_URL || 'http://localhost:3000',
  headers: { 'X-API-Key': process.env.OPENWA_API_KEY || '' },
  timeout: 20000,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getWithRetry(url: string, tries = 4): Promise<any> {
  for (let i = 0; i < tries; i++) {
    try {
      const { data } = await openwa.get(url);
      return data;
    } catch (e: any) {
      if (e?.response?.status === 429 && i < tries - 1) {
        await sleep(2000 * (i + 1));
        continue;
      }
      throw e;
    }
  }
}

type OwaMessage = {
  waMessageId?: string;
  chatId: string;
  from?: string;
  body?: string;
  type?: string;
  direction?: string;
  timestamp?: number;
  createdAt?: string;
};

async function main() {
  const sessions = await getWithRetry('/api/sessions');
  const dbSessions = await prisma.whatsappSession.findMany();

  let imported = 0;
  for (const s of sessions as Array<{ id: string; name: string }>) {
    const dbSession = dbSessions.find((d) => d.sessionName === s.name);
    if (!dbSession) {
      console.log(`skip ${s.name} — no DB session row`);
      continue;
    }

    const groupsData = await getWithRetry(`/api/sessions/${s.id}/groups`);
    const groups: Array<{ id?: string; chatId?: string }> = Array.isArray(groupsData)
      ? groupsData
      : groupsData?.groups || [];

    for (const g of groups) {
      const gid = g.id || g.chatId;
      if (!gid?.includes('@g.us')) continue;

      await sleep(600); // stay under OpenWA's rate limit
      const msgData = await getWithRetry(
        `/api/sessions/${s.id}/messages?chatId=${encodeURIComponent(gid)}&limit=500`
      );
      const messages: OwaMessage[] = msgData.messages || msgData || [];

      for (const m of messages) {
        if (!m.waMessageId) continue;
        const exists = await prisma.groupMessage.findUnique({
          where: { waMessageId: m.waMessageId },
        });
        if (exists) continue;

        const body = (m.body || '').trim();
        if (!body) continue;
        // OpenWA stores raw base64 for media bodies — skip those blobs
        if (body.length > 2000 && !body.includes(' ')) continue;

        const fromMe =
          m.direction === 'OUTBOUND' ||
          m.waMessageId.startsWith('true_') ||
          m.from === dbSession.phoneNumber;

        await prisma.groupMessage.create({
          data: {
            sessionId: dbSession.id,
            groupId: normalizeGroupId(gid) || gid,
            waMessageId: m.waMessageId,
            direction: fromMe ? 'OUTBOUND' : 'INBOUND',
            body,
            senderId: m.from || undefined,
            timestamp: m.timestamp
              ? new Date(m.timestamp * 1000)
              : m.createdAt
                ? new Date(m.createdAt)
                : new Date(),
          },
        });
        imported++;
      }
    }
    console.log(`synced session ${s.name}`);
  }
  console.log(`done — imported ${imported} group messages`);
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
