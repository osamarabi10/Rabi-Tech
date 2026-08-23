'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  CheckCircle2,
  ChevronRight,
  Clock,
  Loader2,
  Lock,
  MessageSquarePlus,
  Paperclip,
  Phone,
  Search,
  Send,
  Tag,
  User,
  Zap,
  X,
  PanelRight,
  Plus,
  MessageSquare,
  RotateCw,
  AlertCircle,
  WifiOff,
  ImageOff,
  AlarmClock,
  AlarmClockOff,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Composer } from '@/components/inbox/composer';
import { ContactPanel } from '@/components/inbox/contact-panel';
import { avatarColor, STATUS_CONFIG } from '@/lib/constants';
import {
  defaultSessionName,
  fetchConversations,
  fetchMessages,
  fetchOlderMessages,
  fetchAgents,
  fetchTemplates,
  saveTemplate,
  fetchInboxConfig,
  fetchInboxViews,
  sendReply as apiSendReply,
  startConversation,
  updateConversation,
  updateConversationLabels,
  fetchTemplatesByShortCode,
  type Conv,
  type InboxView,
  type Msg,
  type Agent,
  type Template,
  type InboxConfig,
  isClientRating,
  fetchSessions,
  fetchMentionedConversations,
  isSnoozed,
  snoozeConversation,
  retryMessage,
  contactDisplayName,
  UNKNOWN_CONTACT,
  type Session,
} from '@/lib/data';
import { renderTemplate } from '@/lib/utils';
import { getBackendBaseUrl } from '@/lib/runtime-url';
import { getSocket } from '@/lib/socket';
import { StatusBadge } from '@/components/status-badge';
import { LifecycleChip, useLifecycleStages } from '@/components/inbox/lifecycle-select';
import {
  DEFAULT_SCOPE,
  InboxSelector,
  isRealConversation,
  scopeMatches,
  type InboxScope,
  type ScopeContext,
} from '@/components/inbox/inbox-selector';
import { GatewayNotice, InboxScopeMenu } from '@/components/inbox/inbox-scope-menu';
import {
  ConversationListEmpty,
  ConversationListSkeleton,
  emptyReason,
} from '@/components/inbox/conversation-list-states';
import {
  ComposerReadinessStrip,
  isSendBlocked,
  resolveReadiness,
} from '@/components/inbox/composer-readiness';
import { DENSITY_CLASSES, useDensity, type Density } from '@/lib/density';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useT } from '@/lib/i18n';
import { messageDir } from '@/lib/text-direction';
import { EmptyState } from '@/components/empty-state';
import { formatTimeOfDay } from '@/lib/format-time';

// ── Types ─────────────────────────────────────────────────────────────────────
type ConvStatus = 'all' | 'open' | 'pending' | 'awaiting' | 'mine' | 'resolved';

// ── Helpers ───────────────────────────────────────────────────────────────────
function nowTime() {
  return formatTimeOfDay(new Date());
}

const MEDIA_ICONS: Record<string, string> = {
  image: '🖼️', sticker: '🖼️', video: '🎬', audio: '🎵', ptt: '🎤', document: '📄',
};

/** Arabic source keys; resolved through t() like every other label. */
const MEDIA_LABELS: Record<string, string> = {
  image: 'صورة', sticker: 'ملصق', video: 'فيديو',
  audio: 'صوت', ptt: 'رسالة صوتية', document: 'ملف',
};

function MessageMedia({ mediaUrl, mediaType }: { mediaUrl?: string | null; mediaType?: string | null }) {
  const { t } = useT();
  const type = (mediaType || '').toLowerCase();
  /**
   * Whether the image refused to load.
   *
   * It used to be hidden — `style.display = 'none'` in the error handler —
   * which turned every failure into an empty bubble. Images had in fact been
   * 401ing for a long time, and because the tag erased itself the symptom was
   * "images do not appear" rather than "images are broken": no icon, no gap,
   * nothing to report. A failure nobody can see is a failure nobody fixes.
   */
  const [failed, setFailed] = useState(false);
  if (!mediaUrl) {
    if (!mediaType) return null;
    return (
      <div className="mb-1 flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
        <span>{MEDIA_ICONS[type] || '📎'}</span>
        <span>{t(MEDIA_LABELS[type] || 'مرفق')}</span>
      </div>
    );
  }
  const src = mediaUrl.startsWith('/') ? `${getBackendBaseUrl()}${mediaUrl}` : mediaUrl;
  if (type === 'image' || type === 'sticker') {
    if (failed) {
      return (
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="mb-1 flex items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-micro text-muted-foreground transition-colors hover:bg-accent"
        >
          <ImageOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {/* Openable anyway: the agent may have a session the tag did not,
              and "try it yourself" beats a dead end. */}
          {t('تعذّر تحميل الصورة — افتحها بتبويب جديد')}
        </a>
      );
    }
    return (
      <img
        src={src}
        alt=""
        className="mb-1 max-h-64 max-w-full rounded-lg object-contain"
        onError={() => setFailed(true)}
      />
    );
  }
  if (type === 'video') return <video src={src} controls className="mb-1 max-h-64 max-w-full rounded-lg" />;
  if (type === 'audio' || type === 'ptt') return <audio src={src} controls className="mb-1 w-full" />;
  return (
    <a href={src} target="_blank" rel="noopener noreferrer" className="mb-1 flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent">
      <span>📎</span><span>{t('ملف مرفق')}</span>
    </a>
  );
}


const PREDEFINED_LABELS: Array<{ text: string; color: string }> = [];

function labelColor(text: string): string {
  return PREDEFINED_LABELS.find((l) => l.text === text)?.color ?? '#6B7280';
}

// ── Main Component ─────────────────────────────────────────────────────────────
const DENSITY_OPTIONS: { key: Density; label: string }[] = [
  { key: 'compact', label: 'مضغوط' },
  { key: 'comfortable', label: 'مريح' },
  { key: 'spacious', label: 'واسع' },
];

export default function InboxPage() {
  const { t } = useT();
  const [convFilter, setConvFilter] = useState<ConvStatus>('all');

  /**
   * Which queue is being looked at, as opposed to which status it is in.
   *
   * Scope and status are orthogonal and combine — "my conversations that are
   * still open", "the Sales queue at the Qualified stage". Keeping them apart
   * is what lets the selector column exist without duplicating the status
   * pills already in the list.
   */
  const [scope, setScope] = useState<InboxScope>(DEFAULT_SCOPE);

  /**
   * Live gateway sessions, for the composer readiness strip.
   *
   * `null` means not yet known, which the strip renders as "checking" rather
   * than as a fault — an agent should never be told the channel is down
   * because a request has not come back yet.
   */
  const [liveSessions, setLiveSessions] = useState<Session[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const read = () =>
      fetchSessions()
        .then((next) => {
          if (!cancelled) setLiveSessions(next);
        })
        .catch(() => {
          if (!cancelled) setLiveSessions([]);
        });

    read();
    const timer = setInterval(read, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [selId, setSelId] = useState<string | null>(null);

  /**
   * `?conversation=<id>` opens that thread directly.
   *
   * This is what makes a report number falsifiable: every drill-down row links
   * here, so a manager can click a total and land in the conversation it was
   * counted from. The notification bell uses it for the same reason.
   *
   * `?conv=` is accepted as well: the notification bell linked with that name
   * for as long as it has existed, so every unread notification already in a
   * user’s list points at it. The bell now writes the long form, but dropping
   * the short one would quietly break links that are already out there.
   */
  const params = useSearchParams();
  const requestedConvId = params.get('conversation') ?? params.get('conv');

  /** The tenant’s pipeline, for the header chip and the contact panel. */
  const lifecycleStages = useLifecycleStages();

  /** How much of the screen each conversation row is allowed to take. */
  const { density, setDensity } = useDensity();
  const rowDensity = DENSITY_CLASSES[density];
  const [messages, setMessages] = useState<Msg[]>([]);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [oldestMsgId, setOldestMsgId] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  /**
   * True until the first conversation fetch settles.
   *
   * Only the *first* one. A refresh keeps the existing rows on screen and
   * updates them in place — replacing a list the agent is reading with a
   * skeleton every sixty seconds would be worse than showing nothing at all.
   */
  const [firstLoad, setFirstLoad] = useState(true);
  const [techs, setTechs] = useState<Agent[]>([]);
  const [reply, setReply] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const replyError = reply.length > 3000 ? t('الرسالة طويلة جداً') : null;
  const [search, setSearch] = useState('');
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [quickTemplates, setQuickTemplates] = useState<Template[]>([]);
  const [allTemplates, setAllTemplates] = useState<Template[]>([]);
  const [showTplPicker, setShowTplPicker] = useState(false);
  const [tplSearch, setTplSearch] = useState('');
  const [showNewChat, setShowNewChat] = useState(false);
  const [newPhone, setNewPhone] = useState('');
  const [newName, setNewName] = useState('');
  const [startingChat, setStartingChat] = useState(false);
  /**
   * The workspace's configured numbers, each with the team it belongs to.
   *
   * This state existed and was never populated — declared, typed, and always
   * null. It is what the new-conversation dialog needs to say which number a
   * customer will see the message from, so it is filled in now rather than
   * deleted.
   */
  const [inboxSessions, setInboxSessions] = useState<InboxConfig['sessions'] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchInboxConfig()
      .then((config) => {
        if (!cancelled) setInboxSessions(config.sessions);
      })
      .catch(() => {
        if (!cancelled) setInboxSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Conversations this user was @mentioned in.
   *
   * Refreshed alongside the conversation list rather than on its own timer:
   * a mention arrives with a message, so the two are already in step, and a
   * second poller would be a second thing to get wrong.
   */
  const [mentionedConvs, setMentionedConvs] = useState<Set<string>>(new Set());
  /**
   * Saved views this user can see: their own, plus every shared one.
   *
   * Starts empty rather than null. A scope of kind 'view' matches nothing
   * while the list is empty, so the moment before these arrive shows an empty
   * view instead of every conversation in the workspace under someone's saved
   * heading.
   */
  const [inboxViews, setInboxViews] = useState<InboxView[]>([]);

  const refreshMentions = useCallback(() => {
    fetchMentionedConversations()
      .then((result) => setMentionedConvs(new Set(result.conversationIds)))
      .catch(() => {
        // Left as it was. Emptying the set would make the Mentions row
        // disappear mid-session over one failed request.
      });
  }, []);

  useEffect(() => {
    refreshMentions();
  }, [refreshMentions]);

  /** Which number a new conversation should go out from, by its team. */
  const [newTeamId, setNewTeamId] = useState<string>('');

  /**
   * The sending options, one per team.
   *
   * Sessions are listed per session, and a team can own more than one — which
   * produced two entries carrying the same value. The server resolves the
   * session from the team, so both would have sent from the same number: a
   * choice that is not a choice. Deduplicated here, preferring whichever of a
   * team's sessions is actually linked.
   */
  const senderOptions = useMemo(() => {
    const byTeam = new Map<string, { teamId: string; label: string; phone: string | null }>();

    for (const session of inboxSessions ?? []) {
      if (!session.teamId) continue;
      const existing = byTeam.get(session.teamId);
      // A linked session wins: its number is the one a customer will see, and
      // an unlinked one cannot send at all.
      if (existing?.phone && !session.phoneNumber) continue;
      byTeam.set(session.teamId, {
        teamId: session.teamId,
        label: session.label || session.sessionName,
        phone: session.phoneNumber,
      });
    }

    return [...byTeam.values()];
  }, [inboxSessions]);
  const [showDetails, setShowDetails] = useState(true);
  const [assigning, setAssigning] = useState(false);
  const [isInternalNote, setIsInternalNote] = useState(false);
  const [shortCodeMatches, setShortCodeMatches] = useState<Template[]>([]);

  /**
   * Teammates matching the `@` fragment being typed, and the ones already
   * inserted.
   *
   * `mentioned` holds ids rather than names because that is what gets sent.
   * Re-deriving them from the note text at send time would break on two
   * agents sharing a display name, and on any name containing a space.
   */
  const [mentionMatches, setMentionMatches] = useState<{ id: string; name: string }[]>([]);
  const [mentioned, setMentioned] = useState<{ id: string; name: string }[]>([]);
  const [shortCodeIdx, setShortCodeIdx] = useState(0);
  const [labelMenuOpen, setLabelMenuOpen] = useState(false);
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [searchDebounceTimer, setSearchDebounceTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  const [isSearchMode, setIsSearchMode] = useState(false);
  const labelMenuRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  /** The conversation the thread is currently pinned to, to detect a switch. */
  const pinnedConvRef = useRef<string | null>(null);
  /** Scroll height captured before older messages are prepended. */
  const restoreHeightRef = useRef<number | null>(null);
  const [hasUnreadBelow, setHasUnreadBelow] = useState(false);
  /**
   * The message currently being retried.
   *
   * A single id rather than a boolean: the thread can hold several failed
   * sends, and disabling all of their buttons because one is in flight would
   * be wrong about the other ones.
   */
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const currentUser = (() => {
    try { return JSON.parse(localStorage.getItem('rabitech_user') || '{}'); } catch { return {}; }
  })();

  const sel = convs.find((c) => c.id === selId) || null;

  /**
   * Re-attempt a send that failed.
   *
   * The server updates the same row, so the thread swaps the bubble in place
   * instead of appending a second copy of the message.
   */
  const handleRetry = async (messageId: string) => {
    if (!selId || retryingId) return;
    setRetryingId(messageId);
    try {
      const updated = await retryMessage(selId, messageId);
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, ...updated } : m)));
      toast.success(t('تم إرسال الرسالة'));
    } catch (err: any) {
      // The server's reason, not a generic failure: it already classified
      // this into something the agent can act on, and replacing it with
      // "retry failed" would throw that away.
      const reason = err?.response?.data?.error ?? t('تعذّرت إعادة الإرسال');
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, failureReason: reason } : m)),
      );
      // Through t() for the same reason the bubble is: the server writes
      // these in Arabic and this workspace may not be reading Arabic.
      toast.error(t(reason));
    } finally {
      setRetryingId(null);
    }
  };

  // ── Data loading ────────────────────────────────────────────────────────────
  const loadConvs = useCallback(async (keepSel = false, filter: ConvStatus = convFilter, forceLoad = false) => {
    if (!forceLoad && isSearchMode) return; // don't overwrite search results
    try {
      // A thread reached by id is included even when resolved — a drill-down
      // for "conversations resolved this month" links almost entirely to
      // threads the default filter hides.
      const includeResolved = filter === 'resolved' || filter === 'all' || !!requestedConvId;
      const list = await fetchConversations({ includeResolved });
      setConvs(list);
      setFirstLoad(false);
      if (!keepSel) {
        // On a phone the thread replaces the list, so auto-selecting would drop
        // the user straight into a conversation they never picked. Desktop shows
        // both panes at once, where preselecting is a convenience.
        // A conversation asked for by id wins over both rules below: it was
        // chosen deliberately, including on a phone.
        const requested = requestedConvId
          ? list.find((c) => c.id === requestedConvId)
          : undefined;
        if (requested) {
          setSelId(requested.id);
          return;
        }
        const isNarrow = typeof window !== 'undefined' && window.innerWidth < 768;
        const first = isNarrow ? undefined : list.find(
          (c) => !c.phone.includes('status@broadcast') && !c.name.includes('status@broadcast')
        );
        setSelId(first?.id ?? null);
      }
    } catch {
      toast.error(t('فشل تحميل المحادثات'));
      // Cleared on failure too, otherwise the skeleton runs for ever and the
      // list looks like it is still working when it has already given up.
      setFirstLoad(false);
    }
  }, [convFilter, isSearchMode, requestedConvId]);

  /**
   * Leave server-side search and put the normal list back.
   *
   * This lived inline in the search box's onChange, which meant the only way
   * out of search mode was to empty that one input. Clearing filters from
   * anywhere else reset the text but left `isSearchMode` true, so the list
   * stayed pinned to the last (often empty) search result while every count
   * in the sidebar read zero and nothing on screen explained why. Deleting
   * back to one or two characters stranded it the same way.
   */
  const exitSearchMode = useCallback(() => {
    setSearchDebounceTimer((pending) => {
      if (pending) clearTimeout(pending);
      return null;
    });
    setIsSearchMode(false);
    // `true` forces the load past the isSearchMode guard, which is still
    // reading the pre-update value in this render.
    loadConvs(true, convFilter, true);
  }, [convFilter, loadConvs]);

  useEffect(() => { loadConvs(); }, [convFilter, loadConvs]);

  useEffect(() => {
    fetchAgents().then(setTechs);
    fetchInboxConfig().then((cfg) => {
      setInboxSessions(cfg.sessions);
    });
    // Saved views fail quietly to an empty list. Losing them costs an agent
    // their shortcuts; a thrown error here would cost them the whole inbox.
    fetchInboxViews()
      .then(setInboxViews)
      .catch(() => setInboxViews([]));
  }, []);

  useEffect(() => {
    fetchTemplates({ category: 'QUICK_REPLY' }).then(setQuickTemplates);
    fetchTemplates().then(setAllTemplates);
  }, []);


  useEffect(() => {
    if (!selId) { setMessages([]); setHasMoreMessages(false); setOldestMsgId(null); return; }
    let cancelled = false;
    fetchMessages(selId).then((res) => {
      if (!cancelled) {
        setMessages(res.messages);
        setHasMoreMessages(res.hasMore);
        setOldestMsgId(res.oldestId);
      }
    });
    setConvs((p) => p.map((c) => (c.id === selId ? { ...c, unread: 0 } : c)));
    const socket = getSocket();
    socket.emit('join_conversation', selId);
    return () => { cancelled = true; socket.emit('leave_conversation', selId); };
  }, [selId]);

  // ── Notifications ───────────────────────────────────────────────────────────
  const baseTitleRef = useRef<string>('');
  const unreadRef = useRef(0);
  const [, forceTitleTick] = useState(0);

  useEffect(() => {
    baseTitleRef.current = document.title;
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const reset = () => {
      if (!document.hidden) { unreadRef.current = 0; document.title = baseTitleRef.current; forceTitleTick((x) => x + 1); }
    };
    document.addEventListener('visibilitychange', reset);
    window.addEventListener('focus', reset);
    return () => { document.removeEventListener('visibilitychange', reset); window.removeEventListener('focus', reset); };
  }, []);

  const playDing = useCallback(() => {
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const tone = (freq: number, start: number, dur: number) => {
        const osc = ctx.createOscillator(); const gain = ctx.createGain();
        osc.type = 'sine'; osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, ctx.currentTime + start);
        gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + start + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(ctx.currentTime + start); osc.stop(ctx.currentTime + start + dur);
      };
      tone(880, 0, 0.12); tone(1175, 0.1, 0.18);
      setTimeout(() => ctx.close(), 500);
    } catch { /* noop */ }
  }, []);

  const notify = useCallback((title: string, body: string | undefined, onOpen?: () => void) => {
    playDing();
    if (!document.hidden) return;
    unreadRef.current += 1;
    document.title = `(${unreadRef.current}) ${baseTitleRef.current}`;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try {
      const n = new Notification(title, { body, icon: '/favicon.ico', tag: 'rabitech-inbox' });
      n.onclick = () => { window.focus(); onOpen?.(); n.close(); };
    } catch { /* noop */ }
  }, [playDing]);

  // ── Socket + polling ────────────────────────────────────────────────────────
  useEffect(() => {
    const socket = getSocket();
    if (!socket.connected) socket.connect();

    const refreshOpenChat = (conversationId: string) => {
      if (conversationId === selId) fetchMessages(conversationId).then((res) => { setMessages(res.messages); setHasMoreMessages(res.hasMore); setOldestMsgId(res.oldestId); });
      loadConvs(true, convFilter, true);
    };

    const onNewMessage = (p: { conversationId: string }) => {
      if (document.hidden || p.conversationId !== selId)
        notify(t('رسالة جديدة 📩'), t('وصلتك رسالة واتساب جديدة'), () => setSelId(p.conversationId));
      refreshOpenChat(p.conversationId);
    };


    const onMsgAck = (p: { messageId: string; status: string }) => {
      setMessages((prev) => prev.map((m) => m.id === p.messageId ? { ...m, status: p.status as any } : m));
    };

    socket.on('new_message', onNewMessage);
    socket.on('new_conversation', () => loadConvs(true));
    socket.on('conversation_resolved', () => loadConvs(true));
    socket.on('unread_update', (p?: { conversationId?: string }) => {
      if (p?.conversationId) refreshOpenChat(p.conversationId); else loadConvs(true);
    });

    socket.on('message_ack', onMsgAck);

    /*
     * Saved views change under people. A supervisor renaming a shared view
     * must not leave four agents clicking a heading that no longer says what
     * it does, and a deleted one must not sit there 404ing.
     *
     * The payload carries the whole view, so this applies the change rather
     * than re-fetching: a refetch on every keystroke of a rename would be a
     * request per character for every member of the workspace.
     */
    const onViewChanged = (p: {
      action: 'created' | 'updated' | 'deleted';
      viewId: string;
      view?: InboxView;
    }) => {
      setInboxViews((prev) => {
        const without = prev.filter((v) => v.id !== p.viewId);
        if (p.action === 'deleted' || !p.view) return without;
        return [...without, p.view].sort(
          (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
        );
      });
      // The open scope just stopped existing. Falling back rather than
      // leaving the list empty under a heading that is gone.
      if (p.action === 'deleted') {
        setScope((current) =>
          current.kind === 'view' && current.value === p.viewId ? DEFAULT_SCOPE : current,
        );
      }
    };
    socket.on('inbox_view_changed', onViewChanged);

    // Sockets already deliver new_message, new_conversation, conversation_resolved
    // and unread_update. The old 8s poll re-fetched the whole conversation list and
    // the open thread on top of that — pure duplicate load that also made the list
    // flicker. Kept only as a slow safety net for a dropped socket connection.
    const poll = setInterval(() => {
      if (!getSocket().connected) loadConvs(true);
    }, 30_000);

    return () => {
      socket.off('new_message', onNewMessage);
      socket.off('new_conversation'); socket.off('conversation_resolved');
      socket.off('unread_update');
      socket.off('message_ack', onMsgAck);
      socket.off('inbox_view_changed', onViewChanged);
      if (poll) clearInterval(poll);
    };
  }, [selId, loadConvs, notify]);

  /** Radix renders the scrollable element inside ScrollArea, not on it. */
  const threadViewport = useCallback((): HTMLElement | null => {
    return threadRef.current?.querySelector<HTMLElement>(
      '[data-radix-scroll-area-viewport]',
    ) ?? null;
  }, []);

  /**
   * Whether the agent was at the bottom *before* this update.
   *
   * Recorded from real scroll events rather than measured inside the message
   * effect. Measuring there reads a layout that has not settled yet — right
   * after opening a conversation the thread has not finished laying out, so
   * the distance looks enormous and the "new messages" pill appears
   * immediately, on a thread the agent is already looking at the bottom of.
   */
  const atBottomRef = useRef(true);

  /** Stable: reads geometry off the event target, so it never needs rebinding. */
  const onThreadScroll = useCallback((event: Event) => {
    const viewport = event.currentTarget as HTMLElement;
    // A threshold, not equality: sub-pixel rounding and the composer resizing
    // both leave you a few pixels off the true bottom.
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    atBottomRef.current = distance <= 120;
    if (atBottomRef.current) setHasUnreadBelow(false);
  }, []);

  const boundViewportRef = useRef<HTMLElement | null>(null);

  /**
   * Bind to whichever viewport is currently mounted, keyed on the element
   * rather than on `selId`.
   *
   * The thread pane only renders once the conversation itself has loaded,
   * which is a render *after* `selId` changes. An effect depending on `selId`
   * alone therefore found no viewport, returned, and never ran again — so the
   * listener was never attached and `atBottomRef` stayed stuck at its initial
   * `true`. That failed silently: opening a thread still jumped to the newest
   * message (a different effect does that), it just never noticed the agent
   * scrolling away, so every inbound message yanked them back down.
   *
   * No dependency array on purpose. The body is an identity compare that exits
   * immediately in the common case.
   */
  useEffect(() => {
    const viewport = threadViewport();
    if (viewport === boundViewportRef.current) return;
    boundViewportRef.current?.removeEventListener('scroll', onThreadScroll);
    boundViewportRef.current = viewport;
    viewport?.addEventListener('scroll', onThreadScroll, { passive: true });
  });

  useEffect(
    () => () => {
      boundViewportRef.current?.removeEventListener('scroll', onThreadScroll);
    },
    [onThreadScroll],
  );

  /**
   * Auto-scroll only when the agent was already at the bottom.
   *
   * This used to scroll on every messages change, unconditionally. Reading
   * back through a thread and having an inbound message yank you to the
   * bottom is bad; doing it after "load older messages" — which changes
   * `messages` too — threw away the history the agent had just asked for.
   */
  useEffect(() => {
    const viewport = threadViewport();
    if (!viewport) return;

    // Older messages were prepended: hold the reading position by adding back
    // exactly the height that appeared above it.
    if (restoreHeightRef.current !== null) {
      const added = viewport.scrollHeight - restoreHeightRef.current;
      viewport.scrollTop += added;
      restoreHeightRef.current = null;
      return;
    }

    // Switching conversation always starts at the newest message, with no
    // animation — a smooth scroll through a long history looks like a bug.
    if (pinnedConvRef.current !== selId) {
      pinnedConvRef.current = selId;
      atBottomRef.current = true;
      setHasUnreadBelow(false);
      endRef.current?.scrollIntoView({ behavior: 'auto' });
      return;
    }

    if (atBottomRef.current) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    } else {
      // Position is kept. Tell them something arrived rather than moving them.
      setHasUnreadBelow(true);
    }
  }, [messages, selId, threadViewport]);

  const jumpToLatest = useCallback(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
    atBottomRef.current = true;
    setHasUnreadBelow(false);
  }, []);

  // ── Actions ─────────────────────────────────────────────────────────────────
  const pushLocalMsg = (body: string, auto = false) => {
    const msg: Msg = { id: `local-${Date.now()}`, dir: 'out', body, time: nowTime(), auto, sentByName: currentUser?.name };
    setMessages((p) => [...p, msg]);
    setConvs((p) => p.map((c) => (c.id === selId ? { ...c, lastMsg: body, lastTime: msg.time } : c)));
  };

  const handleSend = async () => {
    setSendError(null);
    if (!reply.trim()) { setSendError(t('أدخل رسالة')); return; }
    if (!sel) { setSendError(t('اختر محادثة')); return; }
    if (replyError) { setSendError(replyError); return; }
    const body = reply;
    const internal = isInternalNote;
    setReply(''); setSendError(null); setIsInternalNote(false); setShortCodeMatches([]);
    setMentionMatches([]); setMentioned([]);
    try {
      // Only the teammates still named in the note. Someone mentioned and
      // then deleted from the text should not be notified.
      const stillMentioned = internal
        ? mentioned.filter((user) => body.includes(`@${user.name}`)).map((user) => user.id)
        : [];
      const sent = await apiSendReply(sel.id, body, internal, stillMentioned);
      setMessages((p) => [...p, sent]);
      setConvs((p) => p.map((c) => (c.id === sel.id ? { ...c, lastMsg: body, lastTime: sent.time } : c)));
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || t('فشل إرسال الرسالة');
      setSendError(msg); toast.error(msg);
    }
  };

  const handleResolve = async () => {
    if (!sel) return;
    setShowCloseConfirm(false);
    try {
      // Resolve + unassign in one call
      await updateConversation(sel.id, { status: 'RESOLVED', assignedToId: null });
      setConvs((p) => p.filter((c) => c.id !== sel.id));
      setSelId(null); setMessages([]);
      toast.success(t('تم إغلاق المحادثة ✅'));
    } catch { toast.error(t('فشل تحديث الحالة')); }
  };

  const handleSetPending = async () => {
    if (!sel) return;
    try {
      await updateConversation(sel.id, { status: 'PENDING' });
      setConvs((p) => p.map((c) => c.id === sel.id ? { ...c, status: 'PENDING' } : c));
      toast.success(t('تم تعيين المحادثة كـ معلقة'));
    } catch { toast.error(t('فشل تحديث الحالة')); }
  };

  const handleAssign = async (agentId: string | null) => {
    if (!sel) return;
    setAssigning(true);
    try {
      await updateConversation(sel.id, { assignedToId: agentId });
      setConvs((p) => p.map((c) => {
        if (c.id !== sel.id) return c;
        const tech = techs.find((t) => t.id === agentId);
        return { ...c, assigneeId: agentId, assigneeName: tech?.name ?? null };
      }));
      toast.success(agentId ? t('تم تعيين الوكيل') : t('تم إلغاء التعيين'));
    } catch { toast.error(t('فشل التعيين')); }
    finally { setAssigning(false); }
  };

  // Send a template body immediately without putting it in the textarea
  const handleSendDirect = async (body: string) => {
    if (!sel) return;
    const rendered = renderTemplate(body, {
      contactName: sel.name,
      contactPhone: sel.phone,
      agentName: currentUser?.name || '',
    });
    try {
      await apiSendReply(sel.id, rendered);
      const updated = await fetchMessages(sel.id);
      setMessages(updated.messages); setHasMoreMessages(updated.hasMore); setOldestMsgId(updated.oldestId);
    } catch { toast.error(t('فشل إرسال الرسالة')); }
  };

  const expandShortCode = (tpl: Template) => {
    if (!sel) return;
    const rendered = renderTemplate(tpl.body, {
      contactName: sel.name,
      contactPhone: sel.phone,
      agentName: currentUser?.name || '',
    });
    setReply(rendered);
    setShortCodeMatches([]);
  };

  const handleUpdateLabels = async (labels: string[]) => {
    if (!sel) return;
    try {
      await updateConversationLabels(sel.id, labels);
      setConvs((p) => p.map((c) => c.id === sel.id ? { ...c, labels } : c));
    } catch { toast.error(t('فشل تحديث التصنيفات')); }
  };

  /**
   * Snooze the open thread, or wake it.
   *
   * Durations rather than a date picker: "later today" and "tomorrow" are
   * what an agent actually means, and asking them to pick a minute is asking
   * a question they do not have an answer to.
   */
  const handleSnooze = async (hours: number | null) => {
    if (!selId) return;
    const until = hours === null ? null : new Date(Date.now() + hours * 3600_000);
    try {
      await snoozeConversation(selId, until);
      setConvs((prev) =>
        prev.map((c) =>
          c.id === selId
            ? { ...c, snoozedUntil: until ? until.toISOString() : null }
            : c,
        ),
      );
      toast.success(until ? t('تم تأجيل المحادثة') : t('رجعت المحادثة للطابور'));
      // Snoozing removes it from the view it was selected in, so keeping it
      // open would leave the thread pane showing a conversation the list no
      // longer contains.
      if (until) setSelId(null);
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? t('فشل تأجيل المحادثة'));
    }
  };

  const handleStartChat = async () => {
    if (!newPhone.trim()) { toast.error(t('أدخل رقم الهاتف')); return; }
    setStartingChat(true);
    try {
      const conv = await startConversation({
        phone: newPhone.trim(),
        name: newName.trim() || undefined,
        // Empty means "let the server decide", which is the right default for
        // an agent who has only one number and never saw the picker.
        teamId: newTeamId || undefined,
      });
      setShowNewChat(false); setNewPhone(''); setNewName(''); setNewTeamId('');
      await loadConvs(true);
      setSelId(conv.id);
      fetchMessages(conv.id).then((res) => { setMessages(res.messages); setHasMoreMessages(res.hasMore); setOldestMsgId(res.oldestId); });
      toast.success(t('تم فتح المحادثة ✅'));
    } catch (err: unknown) {
      toast.error((err as { response?: { data?: { error?: string } } })?.response?.data?.error || t('فشل فتح المحادثة'));
    } finally { setStartingChat(false); }
  };


  /**
   * The scope context, built once per render.
   *
   * Rebuilding it inside the filter would allocate a set wrapper per
   * conversation; memoising it also keeps the identity stable for anything
   * downstream that depends on it.
   */
  const scopeCtx: ScopeContext = useMemo(
    () => ({ currentUserId: currentUser?.id, mentioned: mentionedConvs, views: inboxViews }),
    [currentUser?.id, mentionedConvs, inboxViews],
  );

  // ── Filtered list ───────────────────────────────────────────────────────────
  const filtered = convs
    .filter((c) => !c.phone.includes('status@broadcast') && !c.name.includes('status@broadcast'))
    // Snoozed threads leave every view but their own, status broadcasts are
    // not conversations, and mentions live on notifications. All three rules
    // live in scopeMatches, so this list and the counts beside it are derived
    // from one function rather than from two copies of the same intent.
    .filter((c) => isRealConversation(c) && scopeMatches(c, scope, scopeCtx))
    .filter((c) => {
      if (convFilter === 'open') return c.status === 'OPEN';
      if (convFilter === 'pending') return c.status === 'PENDING';
      if (convFilter === 'awaiting') return c.status === 'AWAITING_CLIENT';
      if (convFilter === 'resolved') return c.status === 'RESOLVED';
      if (convFilter === 'mine') return c.assigneeId === currentUser?.id;
      return true; // 'all'
    })
    .filter((c) => !search.trim() || c.name.includes(search) || c.phone.includes(search))
    .filter((c) => !labelFilter || c.labels.includes(labelFilter));


  /**
   * Sessions that exist but are not connected, by name.
   *
   * Only worth marking rows at all on a workspace with more than one number:
   * if every channel is down the rail already says so across the whole list,
   * and repeating it on each row is noise. What this catches is the case the
   * rail cannot express — two numbers, one of them dead, and no way to tell
   * which conversations just went quiet.
   */
  const offlineSessions = new Set(
    (liveSessions ?? []).filter((session) => !session.connected).map((session) => session.sessionName),
  );
  const markOfflineRows = (liveSessions?.length ?? 0) > 1 && offlineSessions.size > 0
    && offlineSessions.size < (liveSessions?.length ?? 0);

  const readiness = resolveReadiness(
    sel?.sessionName ?? null,
    sel?.sessionPhone ?? null,
    liveSessions,
  );
  // Naming the channel only earns its place on a multi-number workspace.
  const multiChannel = (liveSessions?.length ?? 0) > 1;
  const sendBlocked = isSendBlocked(readiness);

  const z: { color: string } | null = sel ? { color: avatarColor(sel.phone) } : null;
  const sc = sel ? STATUS_CONFIG[sel.status] || STATUS_CONFIG.OPEN : null;
  const unreadTotal = convs.reduce((s, c) => s + c.unread, 0);

  const STATUS_TABS: { key: ConvStatus; label: string; count?: number }[] = [
    { key: 'all',      label: t('الكل'),          count: convs.length },
    { key: 'open',     label: t('مفتوحة'),        count: convs.filter((c) => c.status === 'OPEN').length },
    { key: 'pending',  label: t('معلقة'),          count: convs.filter((c) => c.status === 'PENDING').length },
    { key: 'awaiting', label: t('انتظار العميل'),  count: convs.filter((c) => c.status === 'AWAITING_CLIENT').length },
    { key: 'resolved', label: t('محلولة'),         count: convs.filter((c) => c.status === 'RESOLVED').length },
  ];

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full overflow-hidden" onClick={() => setLabelMenuOpen(false)}>

      {/* ── Panel 1: Conversation list ─────────────────────────────────────── */}
      {/*
        Phones get one pane at a time: the list fills the screen until a
        conversation is picked, then it yields to the thread. Both are always
        side by side from md up.
      */}
      {/*
        Pane 1 of four. Hidden below `lg` so a tablet keeps the three working
        panes rather than squeezing in a fourth; every scope it offers stays
        reachable from the status pills and search inside the list itself.
      */}
      <InboxSelector
        convs={convs}
        scope={scope}
        onScopeChange={setScope}
        currentUserId={currentUser?.id}
        mentioned={mentionedConvs}
        views={inboxViews}
        convFilter={convFilter}
        labelFilter={labelFilter}
        onViewsChanged={setInboxViews}
        className={cn('hidden lg:flex', selId && 'max-lg:hidden')}
      />

      <div className={cn(
        // Conversation list is a white panel on the light canvas, per Respond.io's
        // three-surface split: dark rail, white list, tinted chat canvas.
        'flex-col border-e border-border bg-card',
        'w-full md:w-[280px] md:shrink-0 md:flex',
        selId ? 'hidden' : 'flex',
      )}>

        {/* Mode header */}
        <div className="border-b border-border px-3 pt-3 pb-0">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex gap-1">
              {([] as string[]).map((d) => (
                <button
                  key={d}
                  onClick={() => undefined}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
                    false ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {d === 'it' ? 'IT' : t('مارك')}
                </button>
              ))}
            </div>
          </div>

          {/* Status filter tabs (chats only) */}
          {(
            <>
              {/* Density shares the filter row: it is a view preference, not
                  another thing narrowing the list, so it sits apart at the end
                  rather than among the filters. */}
              <div className="flex items-center gap-1">
              <div className="flex flex-1 gap-1 overflow-x-auto pb-1 [&::-webkit-scrollbar]:hidden">
                {STATUS_TABS.map((tab) => (
                  <button
                    key={tab.key}
                    onClick={() => setConvFilter(tab.key)}
                    className={cn(
                      'flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-caption font-semibold transition-colors',
                      convFilter === tab.key
                        // Solid, not a tint: the count pill nests inside this and
                        // a tint-on-tint stack left it at ~2.9:1.
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                    )}
                  >
                    {tab.label}
                    {tab.count !== undefined && tab.count > 0 && (
                      <span className={cn(
                        'rounded-full px-1 text-micro',
                        // Opaque, not a white overlay: at 10px a translucent pill
                        // over the blue tab only reached 3.4:1.
                        convFilter === tab.key ? 'bg-card font-semibold text-primary' : 'bg-muted',
                      )}>
                        {tab.count}
                      </span>
                    )}
                  </button>
                ))}
              </div>

              <div
                className="flex shrink-0 rounded-md border border-border p-0.5"
                role="group"
                aria-label={t('كثافة العرض')}
              >
                {DENSITY_OPTIONS.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => setDensity(option.key)}
                    title={t(option.label)}
                    aria-pressed={density === option.key}
                    className={cn(
                      'rounded px-1.5 py-0.5 text-micro transition-colors motion-micro',
                      density === option.key
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {t(option.label)}
                  </button>
                ))}
              </div>
              </div>

              {PREDEFINED_LABELS.length > 0 && (
                <div className="flex gap-1 overflow-x-auto pb-2 [&::-webkit-scrollbar]:hidden">
                  {PREDEFINED_LABELS.map((lbl) => (
                    <button
                      key={lbl.text}
                      onClick={() => setLabelFilter((f) => f === lbl.text ? null : lbl.text)}
                      className="shrink-0 rounded-full px-2 py-0.5 text-micro font-medium transition-opacity"
                      style={{
                        backgroundColor: `${lbl.color}${labelFilter === lbl.text ? '35' : '18'}`,
                        color: lbl.color,
                        outline: labelFilter === lbl.text ? `1px solid ${lbl.color}60` : 'none',
                      }}
                    >
                      {lbl.text}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/*
          Below `lg` the scope pane is gone, so its two irreplaceable parts
          come back here: the scopes themselves, and gateway trouble. Both
          are `lg:hidden` — on a wide screen the pane already has them, and
          two copies of the same control is its own kind of confusion.
        */}
        <GatewayNotice sessions={liveSessions} className="lg:hidden" />

        {/* Search + actions */}
        <div className="border-b border-border px-3 py-2 space-y-2">
          <InboxScopeMenu
            convs={convs}
            scope={scope}
            onScopeChange={setScope}
            currentUserId={currentUser?.id}
            mentioned={mentionedConvs}
            views={inboxViews}
            className="lg:hidden"
          />
          {(
            <>
              <div className="relative">
                <Search className="absolute start-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input className="h-8 ps-9 text-xs" placeholder={t('بحث...')} value={search} onChange={(e) => {
                  const val = e.target.value;
                  setSearch(val);
                  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
                  if (val.length >= 3) {
                    setIsSearchMode(true);
                    const t2 = setTimeout(async () => {
                      try {
                        const { data } = await (await import('@/lib/api')).default.get('/api/conversations', {
                          params: { search: val, activeOnly: 'false' },
                        });
                        const { fetchConversations: _fc, ...mapUtils } = await import('@/lib/data');
                        const mapped = data.map((c: any) => ({
                          id: c.id, displayId: c.displayId ?? 0,
                          teamId: c.teamId ?? c.session?.teamId ?? null,
                          teamName: c.team?.name ?? c.session?.team?.name ?? null,
                          name: c.contact?.name || c.contact?.phone || UNKNOWN_CONTACT,
                          phone: c.contact?.phone || '',
                          zoneId: c.contact?.zoneId || '', zoneNameAr: c.contact?.zone?.nameAr || '',
                          status: c.status, ticketId: null, ticketStatus: null, ticketPriority: null,
                          lastMsg: c.messages?.[0]?.body || '', lastTime: '',
                          sessionDate: '', unread: 0, avatar: (c.contact?.name || c.contact?.phone || '?').charAt(0),
                          assigneeId: c.assignee?.id ?? null, assigneeName: c.assignee?.name ?? null,
                          contactId: c.contact?.id ?? '', contactTags: c.contact?.tags ?? [],
                          contactNotes: c.contact?.notes ?? null, labels: c.labels ?? [],
                        }));
                        setConvs(mapped);
                      } catch { /* ignore */ }
                    }, 300);
                    setSearchDebounceTimer(t2);
                  } else if (isSearchMode) {
                    // Under three characters there is no server-side search to
                    // show, so fall back to the full list rather than leaving
                    // the previous query's results on screen.
                    exitSearchMode();
                  }
                }} />
              </div>
              <Button size="sm" className="h-8 w-full gap-1.5 text-xs" onClick={() => setShowNewChat(true)}>
                <MessageSquarePlus className="h-3.5 w-3.5" />
                {t('محادثة جديدة')}
              </Button>
            </>
          )}
        </div>

        {/* List */}
        <ScrollArea className="flex-1">
          {firstLoad && <ConversationListSkeleton />}

          {!firstLoad && filtered.length === 0 && (
            <ConversationListEmpty
              reason={emptyReason({
                // `null` means the gateway has not answered yet — treated as
                // "channel present" so a slow request never flashes a fault
                // that is not there. A session row that exists but has never
                // been scanned is not a channel: nothing can arrive on it.
                hasChannel:
                  liveSessions === null ||
                  liveSessions.some((session) => session.connected),
                isFiltered:
                  scope.value !== 'all' ||
                  convFilter !== 'all' ||
                  Boolean(labelFilter) ||
                  Boolean(search.trim()),
                onClear: () => {
                  setScope(DEFAULT_SCOPE);
                  setConvFilter('all');
                  setLabelFilter(null);
                  setSearch('');
                  exitSearchMode();
                },
              })}
            />
          )}

          {filtered.map((c) => {
            const cz = { color: avatarColor(c.phone) };
            const csc = STATUS_CONFIG[c.status] || STATUS_CONFIG.OPEN;
            const isActive = selId === c.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelId(c.id)}
                className={cn(
                  // `text-start` and `before:start-0`, not their physical
                  // equivalents: the active-row marker sat on the right in both
                  // directions, which in English put it on the far edge of the
                  // row instead of against the list.
                  'relative flex w-full border-b border-border/40 text-start transition-colors motion-micro hover:bg-accent/40',
                  rowDensity.row,
                  rowDensity.gap,
                  isActive && 'bg-primary/8 before:absolute before:start-0 before:top-0 before:h-full before:w-0.5 before:bg-primary'
                )}
              >
                <Avatar className={cn(rowDensity.avatar, 'shrink-0')}>
                  {/* Solid fill, white initial — a 12% tint of the same hue put
                      the initial at ~2.9:1 against its own background. */}
                  <AvatarFallback className="text-xs font-bold" style={{ backgroundColor: cz.color, color: '#fff' }}>
                    {c.avatar}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="mb-0.5 flex items-start justify-between gap-1">
                    <span className={cn('truncate text-small font-semibold', isActive ? 'text-foreground' : 'text-foreground/90')}>
                      {contactDisplayName(c.name, t)}
                    </span>
                    <span className="shrink-0 text-micro text-muted-foreground">{c.lastTime}</span>
                  </div>
                  <div className="mb-1 flex items-center gap-1.5">
                    <StatusBadge label={csc.label} color={csc.color} className="px-1.5 py-0 text-micro" />
                    {/*
                      This thread's own channel is down. Named, not just
                      coloured — an icon alone would be one more grey glyph in
                      a row that already has several.
                    */}
                    {markOfflineRows && c.sessionName && offlineSessions.has(c.sessionName) && (
                      <span
                        className="flex shrink-0 items-center gap-0.5 text-micro text-destructive"
                        title={t('لن تصل الردود حتى تعود')}
                      >
                        <WifiOff className="h-2.5 w-2.5" aria-hidden />
                        {t('غير متصلة')}
                      </span>
                    )}
                    {c.assigneeName && (
                      <span className="flex items-center gap-0.5 text-micro text-muted-foreground">
                        <User className="h-2.5 w-2.5" />{c.assigneeName}
                      </span>
                    )}
                  </div>
                  {c.labels.length > 0 && (
                    <div className="mb-0.5 flex flex-wrap gap-0.5">
                      {c.labels.slice(0, 3).map((lbl) => (
                        <span key={lbl} className="rounded-full px-1.5 py-0 text-micro font-medium"
                          style={{ backgroundColor: `${labelColor(lbl)}25`, color: labelColor(lbl) }}>
                          {lbl}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-1">
                    {rowDensity.showPreview ? (
                      <span
                        className={cn('truncate text-caption text-muted-foreground', rowDensity.preview)}
                        dir={messageDir(c.lastMsg)}
                      >
                        {isClientRating(c.lastMsg) ? `⭐ تقييم ${c.lastMsg}/5` : c.lastMsg}
                      </span>
                    ) : (
                      <span />
                    )}
                    {c.unread > 0 && (
                      <Badge className="h-4 min-w-4 shrink-0 rounded-full px-1 text-micro">{c.unread}</Badge>
                    )}
                  </div>
                </div>
              </button>
            );
          })}

        </ScrollArea>
      </div>

      {/* ── Panel 2: Chat ──────────────────────────────────────────────────── */}
      <div className={cn(
        'min-w-0 flex-1 flex-col bg-background md:flex',
        selId ? 'flex' : 'hidden',
      )}>
        {!sel ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <MessageSquarePlus className="h-8 w-8" />
            </div>
            <p className="text-sm font-medium text-foreground">{t('اختر محادثة')}</p>
            <p className="text-xs text-muted-foreground">{t('اختر محادثة من القائمة أو ابدأ محادثة جديدة')}</p>
            {(
              <Button size="sm" variant="outline" className="gap-2" onClick={() => setShowNewChat(true)}>
                <MessageSquarePlus className="h-4 w-4" />
                {t('محادثة جديدة')}
              </Button>
            )}
          </div>
        ) : (
          <>
            {/* Chat header */}
            <div className="flex items-center gap-3 border-b border-border bg-card px-4 py-2.5">
              {/* Phone-only: the list is hidden behind this thread, so offer a way back. */}
              <button
                onClick={() => setSelId(null)}
                aria-label={t('رجوع للمحادثات')}
                className="-ms-1 shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
              <Avatar className="h-9 w-9 shrink-0">
                <AvatarFallback className="text-sm font-bold" style={{ backgroundColor: z!.color, color: '#fff' }}>
                  {sel.avatar}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-bold">{contactDisplayName(sel.name, t)}</span>
                  <span className="shrink-0 text-micro font-mono text-muted-foreground opacity-60">#{sel.displayId}</span>
                  <StatusBadge label={sc!.label} color={sc!.color} className="shrink-0 px-1.5 py-0 text-micro" />
                  {/* Where this contact stands, beside the conversation status.
                      Read-only here: the header is a summary, and the editable
                      control lives in the contact panel next to the rest of the
                      contact’s fields. */}
                  <LifecycleChip value={sel.lifecycleStage} stages={lifecycleStages} />
                  {sel.labels.map((lbl) => (
                    <span key={lbl} className="rounded-full px-2 py-0 text-micro font-medium cursor-pointer"
                      style={{ backgroundColor: `${labelColor(lbl)}25`, color: labelColor(lbl) }}
                      onClick={() => handleUpdateLabels(sel.labels.filter((l) => l !== lbl))}>
                      {lbl} ×
                    </span>
                  ))}
                  {/* Add label button */}
                  {PREDEFINED_LABELS.length > 0 && <div ref={labelMenuRef} className="relative">
                    <button
                      onClick={() => setLabelMenuOpen((v) => !v)}
                      className="flex items-center gap-0.5 rounded-full border border-border/50 px-1.5 py-0 text-micro text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <Tag className="h-2.5 w-2.5" /> +
                    </button>
                    {labelMenuOpen && (
                      <div className="absolute right-0 top-full mt-1 z-50 rounded-lg border border-border bg-card shadow-lg p-1.5 min-w-[130px]">
                        {PREDEFINED_LABELS.filter((l) => !sel.labels.includes(l.text)).map((lbl) => (
                          <button key={lbl.text} type="button"
                            className="flex w-full items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent transition-colors"
                            onClick={() => { handleUpdateLabels([...sel.labels, lbl.text]); setLabelMenuOpen(false); }}>
                            <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: lbl.color }} />
                            {lbl.text}
                          </button>
                        ))}
                        {PREDEFINED_LABELS.every((l) => sel.labels.includes(l.text)) && (
                          <p className="px-2 py-1 text-micro text-muted-foreground">{t('كل التصنيفات مضافة')}</p>
                        )}
                      </div>
                    )}
                  </div>}
                </div>
                <div className="flex items-center gap-2">
                  <span className="numeric text-caption text-muted-foreground" dir="ltr">{sel.phone}</span>
                </div>
              </div>

              <div className="flex items-center gap-1">
                {/* Toggle details panel */}
                <Button variant={showDetails ? 'secondary' : 'ghost'} size="icon" className="h-8 w-8"
                  onClick={() => setShowDetails((v) => !v)} title={t('تفاصيل جهة الاتصال')}>
                  <PanelRight className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Messages */}
            <div className="thread-scroll relative flex min-h-0 flex-1 flex-col" ref={threadRef}>
            <ScrollArea className="flex-1">
              <div className="flex min-h-full w-full flex-col justify-end gap-2 p-4">
                {/* Load older messages */}
                {hasMoreMessages && (
                  <div className="flex justify-center pb-2">
                    <button
                      onClick={async () => {
                        if (!selId || !oldestMsgId || loadingOlder) return;
                        setLoadingOlder(true);
                        try {
                          const res = await fetchOlderMessages(selId, oldestMsgId);
                          // Captured before the state update so the effect can
                          // add back exactly the height that appears above.
                          restoreHeightRef.current =
                            threadViewport()?.scrollHeight ?? null;
                          setMessages((prev) => [...res.messages, ...prev]);
                          setHasMoreMessages(res.hasMore);
                          setOldestMsgId(res.oldestId);
                        } finally { setLoadingOlder(false); }
                      }}
                      disabled={loadingOlder}
                      className="rounded-full border border-border bg-card px-4 py-1.5 text-caption text-muted-foreground hover:bg-accent disabled:opacity-50 transition-colors"
                    >
                      {loadingOlder ? t('جارٍ التحميل...') : t('تحميل رسائل أقدم')}
                    </button>
                  </div>
                )}
                {messages.map((m) => (
                  <div key={m.id} className={cn(
                    'max-w-[68%] rounded-xl px-3 py-2 text-sm leading-relaxed',
                    m.dir === 'in'
                      // Inbound: white card on the tinted canvas, like Respond.io.
                      ? 'self-end rounded-bl-sm border border-border bg-card text-card-foreground shadow-glow-sm'
                      : m.isInternal
                        // Internal notes keep the yellow tint agents recognise.
                        ? 'self-start rounded-br-sm border border-warning/40 bg-note/60 text-foreground'
                        : m.auto
                          ? 'self-start rounded-br-sm border border-border bg-muted text-muted-foreground'
                          // Outbound agent replies: solid primary, white text.
                          : 'self-start rounded-br-sm bg-primary text-primary-foreground'
                  )}>
                    {m.isInternal && (
                      <div className="mb-1 flex items-center gap-1 text-micro font-semibold text-warning">
                        <Lock className="h-2.5 w-2.5" />
                        {t('ملاحظة داخلية')}
                      </div>
                    )}
                    {m.auto && !m.isInternal && (
                      <div className="mb-1 flex items-center gap-1 text-micro font-semibold text-primary">
                        <Zap className="h-3 w-3" />
                        {m.autoType === 'feedback' ? t('شكر وتقييم') : t('رد تلقائي')}
                      </div>
                    )}
                    {m.dir === 'out' && !m.auto && !m.isInternal && m.sentByName && (
                      <p className="mb-0.5 text-micro font-semibold text-primary-foreground/80">{m.sentByName}</p>
                    )}
                    {m.dir === 'in' && isClientRating(m.body) && (
                      <div className="mb-1 text-micro font-semibold text-warning">
                        ⭐ {t('تقييم العميل')}: {m.body}/5
                      </div>
                    )}
                    <MessageMedia mediaUrl={m.mediaUrl} mediaType={m.mediaType} />
                    {/*
                      Direction comes from the message's own content, not the
                      interface language: a Hebrew customer's one English
                      sentence renders LTR inside an RTL interface. Inheriting
                      instead is what misplaces punctuation in mixed text.
                    */}
                    {m.body && !(m.mediaUrl && /^\[.*\]$/.test(m.body)) && (
                      <p className="whitespace-pre-wrap" dir={messageDir(m.body)}>{m.body}</p>
                    )}
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <p className="text-micro opacity-40">{m.time}</p>
                      {m.dir === 'out' && (
                        <span className="text-micro opacity-50">
                          {m.status === 'READ' ? '✓✓' : m.status === 'DELIVERED' ? '✓✓' : m.status === 'SENT' ? '✓' : m.status === 'FAILED' ? '✗' : '○'}
                        </span>
                      )}
                    </div>
                    {/*
                      A failed send used to be a grey ✗ in the corner and
                      nothing else — no cause, and no way to try again short
                      of retyping the whole message. The reason comes from the
                      server, which classified it; the button is only offered
                      because the row still holds what was written.
                    */}
                    {m.dir === 'out' && m.status === 'FAILED' && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-micro text-destructive">
                        <AlertCircle className="h-3 w-3 shrink-0" aria-hidden />
                        <span className="min-w-0 flex-1">
                          {/* Through t() as well: the server stores the reason
                              in Arabic, and a Hebrew or English workspace must
                              not get one Arabic sentence inside its own UI. */}
                          {m.failureReason ? t(m.failureReason) : t('تعذّر الإرسال عبر واتساب')}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleRetry(m.id)}
                          disabled={retryingId === m.id}
                          className="flex shrink-0 items-center gap-1 font-medium underline underline-offset-2 hover:no-underline disabled:opacity-60"
                        >
                          <RotateCw
                            className={`h-3 w-3 ${retryingId === m.id ? 'animate-spin' : ''}`}
                            aria-hidden
                          />
                          {retryingId === m.id ? t('جاري الإرسال...') : t('إعادة المحاولة')}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
                <div ref={endRef} />
              </div>
            </ScrollArea>
            {hasUnreadBelow && (
              <button
                type="button"
                onClick={jumpToLatest}
                className="absolute inset-x-0 bottom-3 mx-auto flex w-fit items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-caption font-medium text-primary-foreground shadow-lg transition-opacity hover:opacity-90"
              >
                {t('رسائل جديدة')}
                <span aria-hidden>↓</span>
              </button>
            )}
            </div>

            {/* Reply box */}
            <div className="border-t border-border bg-card p-3 space-y-2">

              {/* ── Action buttons ── */}
              <div className="flex flex-wrap items-center gap-1.5">
                {sel.status !== 'RESOLVED' && (
                  <Button variant="outline" size="sm" className="h-7 gap-1 text-xs text-success border-success/30 hover:bg-success/15"
                    onClick={() => setShowCloseConfirm(true)}>
                    <CheckCircle2 className="h-3 w-3" />
                    {t('حل')}
                  </Button>
                )}
                {sel.status === 'OPEN' && (
                  <Button variant="outline" size="sm" className="h-7 gap-1 text-xs text-warning border-warning/30 hover:bg-warning/15"
                    onClick={handleSetPending}>
                    <Clock className="h-3 w-3" />
                    {t('معلق')}
                  </Button>
                )}
                {sel.status === 'PENDING' && (
                  <Button variant="outline" size="sm" className="h-7 gap-1 text-xs text-primary border-primary/20 hover:bg-primary/10"
                    onClick={() => { updateConversation(sel.id, { status: 'OPEN' }).then(() => { setConvs((p) => p.map((c) => c.id === sel.id ? { ...c, status: 'OPEN' } : c)); }); }}>
                    {t('إعادة فتح')}
                  </Button>
                )}
                {/*
                  Snooze. Durations, not a date picker — "in three hours" and
                  "tomorrow" are what an agent means, and asking them to choose
                  a minute is asking a question they have no answer to.
                */}
                {isSnoozed(sel) ? (
                  <Button variant="outline" size="sm" className="h-7 gap-1 text-xs text-primary border-primary/20 hover:bg-primary/10"
                    onClick={() => handleSnooze(null)}>
                    <AlarmClockOff className="h-3 w-3" />
                    {t('إلغاء التأجيل')}
                  </Button>
                ) : sel.status !== 'RESOLVED' && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="h-7 gap-1 text-xs">
                        <AlarmClock className="h-3 w-3" />
                        {t('تأجيل')}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => handleSnooze(3)}>
                        {t('بعد 3 ساعات')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => handleSnooze(24)}>
                        {t('بكرا')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => handleSnooze(72)}>
                        {t('بعد 3 أيام')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => handleSnooze(168)}>
                        {t('الأسبوع الجاي')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                {sel.status !== 'RESOLVED' && sel.status !== 'AWAITING_CLIENT' && (
                  <Button variant="outline" size="sm" className="h-7 gap-1 text-xs"
                    style={{ color: 'hsl(var(--status-waiting))', borderColor: 'hsl(var(--status-waiting) / 0.25)' }}
                    onClick={() => {
                      updateConversation(sel.id, { status: 'AWAITING_CLIENT' }).then(() => {
                        setConvs((p) => p.map((c) => c.id === sel.id ? { ...c, status: 'AWAITING_CLIENT' } : c));
                        toast.success(t('تم تعيين "انتظار العميل"'));
                      }).catch(() => toast.error(t('فشل تحديث الحالة')));
                    }}>
                    <Clock className="h-3 w-3" />
                    {t('انتظار العميل')}
                  </Button>
                )}
                {sel.status === 'AWAITING_CLIENT' && (
                  <Button variant="outline" size="sm" className="h-7 gap-1 text-xs text-primary border-primary/20 hover:bg-primary/10"
                    onClick={() => {
                      updateConversation(sel.id, { status: 'OPEN' }).then(() => {
                        setConvs((p) => p.map((c) => c.id === sel.id ? { ...c, status: 'OPEN' } : c));
                      });
                    }}>
                    {t('إعادة فتح')}
                  </Button>
                )}
              </div>

            </div>

            <ComposerReadinessStrip
              readiness={readiness}
              showChannel={multiChannel}
            />

            <Composer
              value={reply}
              onChange={(v) => { setReply(v); setSendError(null); }}
              isInternal={isInternalNote}
              onInternalChange={setIsInternalNote}
              onSend={handleSend}
              // Blocked outright while the channel is down. Letting an agent
              // write a considered reply and discover the failure on send is
              // exactly what the strip above exists to prevent.
              disabled={!sel || (sendBlocked && !isInternalNote)}
              error={sendError}
              shortCodeMatches={shortCodeMatches}
              onShortCodeQuery={(q) => {
                if (!q) { setShortCodeMatches([]); return; }
                fetchTemplatesByShortCode(q)
                  .then((m) => { setShortCodeMatches(m); setShortCodeIdx(0); })
                  .catch(() => {});
              }}
              onShortCodePick={expandShortCode}
              mentionMatches={mentionMatches}
              onMentionQuery={(q) => {
                // Mentions exist only on internal notes: a customer-facing
                // reply must never notify someone the customer never saw named.
                if (q === null || !isInternalNote) { setMentionMatches([]); return; }
                const needle = q.toLowerCase();
                setMentionMatches(
                  techs
                    .filter((agent) => agent.id !== currentUser?.id)
                    .filter((agent) => !needle || agent.name.toLowerCase().includes(needle))
                    .slice(0, 5)
                    .map((agent) => ({ id: agent.id, name: agent.name })),
                );
              }}
              onMentionPick={(user) => {
                // Replace the partial `@fragment` the agent was typing, not
                // every occurrence — the same fragment may appear earlier in
                // the note as ordinary text.
                setReply((prev) => prev.replace(/@[^\s@]*$/, `@${user.name} `));
                setMentioned((prev) =>
                  prev.some((u) => u.id === user.id) ? prev : [...prev, user],
                );
                setMentionMatches([]);
              }}
              quickTemplates={quickTemplates}
              onQuickTemplate={(tpl) =>
                setReply(renderTemplate(tpl.body, {
                  contactName: sel?.name || '',
                  contactPhone: sel?.phone || '',
                  agentName: currentUser?.name || '',
                }))
              }
            />
          </>
        )}
      </div>

      {/* ── Pane 3: Contact context ─────────────────────────────────────── */}
      {sel && showDetails && (
        <ContactPanel
          conversation={sel}
          messages={messages}
          agents={techs}
          assigning={assigning}
          onAssign={handleAssign}
          onClose={() => setShowDetails(false)}
          currentUserId={currentUser?.id}
          onOpenConversation={setSelId}
          onConsentChange={(consent) =>
            setConvs((prev) =>
              prev.map((c) => (c.id === sel.id ? { ...c, marketingConsent: consent } : c)),
            )
          }
        />
      )}

      {/* ── Dialogs ────────────────────────────────────────────────────────── */}
      <Dialog open={showNewChat} onOpenChange={setShowNewChat}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{t('محادثة جديدة')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="new-phone" className="text-xs">{t('رقم الهاتف *')}</Label>
              <Input id="new-phone" dir="ltr" placeholder="0501234567 or +972501234567"
                value={newPhone} onChange={(e) => setNewPhone(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleStartChat()} />
              <p className="text-caption text-muted-foreground">{t('الصيغ المدعومة: 0501234567 أو +972501234567')}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-name" className="text-xs">{t('اسم العميل (اختياري)')}</Label>
              <Input id="new-name" placeholder={t('مثال: أحمد محمد')}
                value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleStartChat()} />
            </div>

            {/*
              Which number the customer will see this from.
              Offered only on a workspace with more than one — on a single-number
              tenant it is a select with one option, which is a decision nobody
              is being asked to make. The server resolves the session from the
              team, so the team is what gets sent.
            */}
            {senderOptions.length > 1 && (
              <div className="space-y-1.5">
                <Label htmlFor="new-sender" className="text-xs">{t('يُرسل من')}</Label>
                <select
                  id="new-sender"
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs"
                  value={newTeamId}
                  onChange={(event) => setNewTeamId(event.target.value)}
                >
                  <option value="">{t('اختيار تلقائي')}</option>
                  {senderOptions.map((option) => (
                    <option
                      key={option.teamId}
                      value={option.teamId}
                      // No linked number means nothing can go out on it. Shown
                      // rather than hidden: "this team cannot send yet" is
                      // information, and its absence from the list is not.
                      disabled={!option.phone}
                    >
                      {option.label}
                      {option.phone ? ` — ${option.phone}` : ` — ${t('غير مربوط')}`}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button className="w-full" disabled={startingChat || !newPhone.trim()} onClick={handleStartChat}>
              {startingChat ? t('جاري الفتح...') : t('فتح المحادثة')}
            </Button>
            <Button className="w-full" variant="outline" onClick={() => setShowNewChat(false)}>{t('إلغاء')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showCloseConfirm} onOpenChange={setShowCloseConfirm}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{t('إغلاق المحادثة')}</DialogTitle></DialogHeader>
          {sel && (
            <p className="text-sm text-muted-foreground">
              {t('سيتم إغلاق التذكرة وإرسال رسالة تقييم تلقائية للعميل')}{' '}
              <strong className="text-foreground">{contactDisplayName(sel.name, t)}</strong>.
            </p>
          )}
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button className="w-full" onClick={handleResolve}>
              <CheckCircle2 className="me-1 h-3.5 w-3.5" />
              {t('تأكيد الإغلاق')}
            </Button>
            <Button className="w-full" variant="outline" onClick={() => setShowCloseConfirm(false)}>{t('إلغاء')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Template picker dialog ─── */}
      <Dialog open={showTplPicker} onOpenChange={setShowTplPicker}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>{t('اختر رسالة')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder={t('بحث في القوالب...')}
              value={tplSearch}
              onChange={(e) => setTplSearch(e.target.value)}
              autoFocus
            />
            <div className="max-h-80 overflow-y-auto space-y-1 pl-1">
              {allTemplates
                .filter((tpl) => !tplSearch || tpl.title.includes(tplSearch) || tpl.body.includes(tplSearch))
                .map((tpl) => (
                  <button key={tpl.id} type="button"
                    className="w-full rounded-lg border border-border bg-secondary/30 px-3 py-2 text-right transition-colors hover:border-primary/40 hover:bg-primary/10"
                    onClick={() => {
                      setReply(renderTemplate(tpl.body, {
                        contactName: sel?.name || '',
                        contactPhone: sel?.phone || '',
                        agentName: currentUser?.name || '',
                      }));
                      setShowTplPicker(false);
                    }}>
                    <p className="text-xs font-semibold text-foreground">{tpl.title}</p>
                    <p className="mt-0.5 line-clamp-2 text-caption text-muted-foreground">{tpl.body}</p>
                  </button>
                ))}
              {allTemplates.filter((tpl) => !tplSearch || tpl.title.includes(tplSearch) || tpl.body.includes(tplSearch)).length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground">{t('لا توجد قوالب')}</p>
              )}
            </div>
          </div>
          <DialogFooter className="justify-between">
            <Link href="/templates" className="text-xs text-primary underline self-center" onClick={() => setShowTplPicker(false)}>
              {t('إدارة القوالب')}
            </Link>
            <Button variant="outline" onClick={() => setShowTplPicker(false)}>{t('إلغاء')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
