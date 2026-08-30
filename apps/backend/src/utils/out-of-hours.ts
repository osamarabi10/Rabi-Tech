import { prisma } from '../prisma';
import { ChannelService } from '../modules/channels/channel.service';
import { OpenWAService } from '../modules/whatsapp/openwa.service';
import { renderTemplate } from './template';
import { isWithinWorkingHours } from './working-hours';
import { getTenantId } from '../lib/tenant-context';

const DAY_LABELS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

function formatWorkDays(days: number[]) {
  return [...days]
    .sort((a, b) => a - b)
    .map((d) => DAY_LABELS[d])
    .join(' · ');
}

export async function getWorkingHoursConfig() {
  const organizationId = getTenantId();
  const include = { outOfHoursTemplate: true, welcomeTemplate: true } as const;
  let row = await prisma.workingHours.findUnique({ where: { organizationId }, include });
  if (!row) {
    const template = await prisma.messageTemplate.findFirst({
      where: { category: 'OUT_OF_HOURS', isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
    row = await prisma.workingHours.create({
      data: {
        organizationId,
        enabled: true,
        timezone: 'Asia/Jerusalem',
        workDays: [0, 1, 2, 3, 4],
        startTime: '08:00',
        endTime: '20:00',
        outOfHoursTemplateId: template?.id,
      },
      include,
    });
  }
  return row;
}

export async function maybeSendOutOfHoursReply(
  session: string,
  phone: string,
  conversationId: string
): Promise<boolean> {
  const wh = await getWorkingHoursConfig();
  if (!wh.enabled || !wh.outOfHoursTemplate || isWithinWorkingHours(wh)) return false;

  const alreadySent = await prisma.message.findFirst({
    where: {
      conversationId,
      autoType: 'out_of_hours',
      timestamp: { gte: new Date(Date.now() - 12 * 60 * 60 * 1000) },
    },
  });
  if (alreadySent) return false;

  const body = renderTemplate(wh.outOfHoursTemplate.body, {
    startTime: wh.startTime,
    endTime: wh.endTime,
    workDays: formatWorkDays(wh.workDays),
  });

  const result = await ChannelService.sendText(session, phone, body).catch(() => null);
  await prisma.message.create({
    data: {
      organizationId: getTenantId(),
      conversationId,
      direction: 'OUTBOUND',
      body,
      isAuto: true,
      autoType: 'out_of_hours',
      status: result ? 'SENT' : 'FAILED',
      ...(result ? { waMessageId: result.providerMessageId } : {}),
    },
  });
  return true;
}
