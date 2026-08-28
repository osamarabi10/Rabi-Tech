import type { Session } from '@/lib/data';

/**
 * What the WhatsApp gateway is doing, and what that costs the workspace.
 *
 * The inbox reported two states — "channel working" and "channel not
 * connected" — for at least five distinct situations. A workspace with three
 * numbers where one had dropped was labelled "not connected", which is untrue
 * of the two that were fine and useless about the one that was not. A
 * workspace that had never scanned a QR got the same sentence as one whose
 * gateway container had crashed, though only one of them has a phone to fix it
 * with.
 *
 * On an unofficial gateway this is the only warning there is. Meta would flag a
 * degrading number; here a dead session is silent right up until a send fails,
 * so each state has to say what it stops working and where to go about it.
 */

export type GatewayState =
  | { kind: 'checking' }
  | { kind: 'none' }
  | { kind: 'needs-qr'; total: number }
  | { kind: 'offline'; total: number }
  | { kind: 'degraded'; connected: number; total: number }
  | { kind: 'healthy'; connected: number; total: number };

export function gatewayState(sessions: Session[] | null): GatewayState {
  if (sessions === null) return { kind: 'checking' };

  const total = sessions.length;
  if (total === 0) return { kind: 'none' };

  const connected = sessions.filter((session) => session.connected).length;
  if (connected === total) return { kind: 'healthy', connected, total };

  if (connected === 0) {
    // A number that has never carried a phone number was never paired, so the
    // fix is a QR scan. One that has been paired before is a reconnect, which
    // the gateway may well do on its own — telling that admin to scan a code
    // sends them looking for one that is not offered.
    const everPaired = sessions.some((session) => session.phoneNumber);
    return everPaired ? { kind: 'offline', total } : { kind: 'needs-qr', total };
  }

  return { kind: 'degraded', connected, total };
}

/**
 * The three strings each state needs, as dictionary keys.
 *
 * Returned rather than rendered so the caller decides the layout — the same
 * facts appear in the inbox rail and can appear anywhere else that has room.
 */
export type GatewayCopy = {
  /** What is happening. */
  label: string;
  /** What it stops working. Null when nothing is impaired. */
  impact: string | null;
  /** Where to go about it, if there is anywhere. */
  action: { label: string; href: string } | null;
  tone: 'muted' | 'success' | 'warning' | 'destructive';
};

const CHANNELS_HREF = '/settings/general#channels';

export function gatewayCopy(state: GatewayState): GatewayCopy {
  switch (state.kind) {
    case 'checking':
      return { label: 'جاري التحقق من القناة', impact: null, action: null, tone: 'muted' };

    case 'none':
      return {
        label: 'ما في رقم واتساب مربوط',
        impact: 'ما رح توصل ولا تنبعت أي رسالة',
        action: { label: 'ربط رقم', href: CHANNELS_HREF },
        tone: 'warning',
      };

    case 'needs-qr':
      return {
        label: 'القناة بانتظار مسح رمز QR',
        impact: 'ما رح توصل ولا تنبعت أي رسالة لحد ما تربط الرقم',
        action: { label: 'مسح الرمز', href: CHANNELS_HREF },
        tone: 'warning',
      };

    case 'offline':
      return {
        label: 'القناة غير متصلة',
        impact: 'الرسائل الواردة ضايعة والردود ما بتنبعت',
        action: { label: 'إعادة الربط', href: CHANNELS_HREF },
        tone: 'destructive',
      };

    case 'degraded':
      return {
        label: 'بعض القنوات غير متصلة',
        // Named as partial on purpose: the agent whose number is fine should not
        // stop replying, and the one whose number is down needs to know it is.
        impact: 'المحادثات على القنوات المفصولة متوقفة',
        action: { label: 'مراجعة القنوات', href: CHANNELS_HREF },
        tone: 'destructive',
      };

    case 'healthy':
      return { label: 'القناة تعمل', impact: null, action: null, tone: 'success' };
  }
}
