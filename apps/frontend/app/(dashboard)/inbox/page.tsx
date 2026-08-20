'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
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
} from 'lucide-react';
import { toast } from 'sonner';
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
  sendReply as apiSendReply,
  startConversation,
  updateConversation,
  updateConversationLabels,
  fetchTemplatesByShortCode,
  type Conv,
  type Msg,
  type Agent,
  type Template,
  type InboxConfig,
  isClientRating,
} from '@/lib/data';
import { renderTemplate } from '@/lib/utils';
import { getBackendBaseUrl } from '@/lib/runtime-url';
import { getSocket } from '@/lib/socket';
import { StatusBadge } from '@/components/status-badge';
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

// ── Types ─────────────────────────────────────────────────────────────────────
type ConvStatus = 'all' | 'open' | 'pending' | 'awaiting' | 'mine' | 'resolved';

// ── Helpers ───────────────────────────────────────────────────────────────────
function nowTime() {
  return new Date().toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
}

const MEDIA_ICONS: Record<string, string> = {
  image: '🖼️', sticker: '🖼️', video: '🎬', audio: '🎵', ptt: '🎤', document: '📄',
};

function MessageMedia({ mediaUrl, mediaType }: { mediaUrl?: string | null; mediaType?: string | null }) {
  const type = (mediaType || '').toLowerCase();
  if (!mediaUrl) {
    if (!mediaType) return null;
    return (
      <div className="mb-1 flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
        <span>{MEDIA_ICONS[type] || '📎'}</span>
        <span>{{ image: 'صورة', sticker: 'ملصق', video: 'فيديو', audio: 'صوت', ptt: 'رسالة صوتية', document: 'ملف' }[type] || 'مرفق'}</span>
      </div>
    );
  }
  const src = mediaUrl.startsWith('/') ? `${getBackendBaseUrl()}${mediaUrl}` : mediaUrl;
  if (type === 'image' || type === 'sticker')
    return <img src={src} alt="" className="mb-1 max-h-64 max-w-full rounded-lg object-contain" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />;
  if (type === 'video') return <video src={src} controls className="mb-1 max-h-64 max-w-full rounded-lg" />;
  if (type === 'audio' || type === 'ptt') return <audio src={src} controls className="mb-1 w-full" />;
  return (
    <a href={src} target="_blank" rel="noopener noreferrer" className="mb-1 flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent">
      <span>📎</span><span>ملف مرفق</span>
    </a>
  );
}


const PREDEFINED_LABELS: Array<{ text: string; color: string }> = [];

function labelColor(text: string): string {
  return PREDEFINED_LABELS.find((l) => l.text === text)?.color ?? '#6B7280';
}

// ── Main Component ─────────────────────────────────────────────────────────────
export default function InboxPage() {
  const { t } = useT();
  const [convFilter, setConvFilter] = useState<ConvStatus>('all');
  const [convs, setConvs] = useState<Conv[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [oldestMsgId, setOldestMsgId] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
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
  const [inboxSessions, setInboxSessions] = useState<InboxConfig['sessions'] | null>(null);
  const [showDetails, setShowDetails] = useState(true);
  const [assigning, setAssigning] = useState(false);
  const [isInternalNote, setIsInternalNote] = useState(false);
  const [shortCodeMatches, setShortCodeMatches] = useState<Template[]>([]);
  const [shortCodeIdx, setShortCodeIdx] = useState(0);
  const [labelMenuOpen, setLabelMenuOpen] = useState(false);
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [searchDebounceTimer, setSearchDebounceTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  const [isSearchMode, setIsSearchMode] = useState(false);
  const labelMenuRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const currentUser = (() => {
    try { return JSON.parse(localStorage.getItem('rabitech_user') || '{}'); } catch { return {}; }
  })();

  const sel = convs.find((c) => c.id === selId) || null;

  // ── Data loading ────────────────────────────────────────────────────────────
  const loadConvs = useCallback(async (keepSel = false, filter: ConvStatus = convFilter, forceLoad = false) => {
    if (!forceLoad && isSearchMode) return; // don't overwrite search results
    try {
      const includeResolved = filter === 'resolved' || filter === 'all';
      const list = await fetchConversations({ includeResolved });
      setConvs(list);
      if (!keepSel) {
        // On a phone the thread replaces the list, so auto-selecting would drop
        // the user straight into a conversation they never picked. Desktop shows
        // both panes at once, where preselecting is a convenience.
        const isNarrow = typeof window !== 'undefined' && window.innerWidth < 768;
        const first = isNarrow ? undefined : list.find(
          (c) => !c.phone.includes('status@broadcast') && !c.name.includes('status@broadcast')
        );
        setSelId(first?.id ?? null);
      }
    } catch {
      toast.error(t('فشل تحميل المحادثات'));
    }
  }, [convFilter, isSearchMode]);

  useEffect(() => { loadConvs(); }, [convFilter, loadConvs]);

  useEffect(() => {
    fetchAgents().then(setTechs);
    fetchInboxConfig().then((cfg) => {
      setInboxSessions(cfg.sessions);
    });
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
      if (poll) clearInterval(poll);
    };
  }, [selId, loadConvs, notify]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

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
    try {
      const sent = await apiSendReply(sel.id, body, internal);
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

  const handleStartChat = async () => {
    if (!newPhone.trim()) { toast.error(t('أدخل رقم الهاتف')); return; }
    setStartingChat(true);
    try {
      const conv = await startConversation({ phone: newPhone.trim(), name: newName.trim() || undefined });
      setShowNewChat(false); setNewPhone(''); setNewName('');
      await loadConvs(true);
      setSelId(conv.id);
      fetchMessages(conv.id).then((res) => { setMessages(res.messages); setHasMoreMessages(res.hasMore); setOldestMsgId(res.oldestId); });
      toast.success(t('تم فتح المحادثة ✅'));
    } catch (err: unknown) {
      toast.error((err as { response?: { data?: { error?: string } } })?.response?.data?.error || t('فشل فتح المحادثة'));
    } finally { setStartingChat(false); }
  };


  // ── Filtered list ───────────────────────────────────────────────────────────
  const filtered = convs
    .filter((c) => !c.phone.includes('status@broadcast') && !c.name.includes('status@broadcast'))
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


  const z: { color: string } | null = sel ? { color: avatarColor(sel.phone) } : null;
  const sc = sel ? STATUS_CONFIG[sel.status] || STATUS_CONFIG.OPEN : null;
  const unreadTotal = convs.reduce((s, c) => s + c.unread, 0);

  const STATUS_TABS: { key: ConvStatus; label: string; count?: number }[] = [
    { key: 'all',      label: t('الكل'),          count: convs.length },
    { key: 'open',     label: t('مفتوحة'),        count: convs.filter((c) => c.status === 'OPEN').length },
    { key: 'pending',  label: t('معلقة'),          count: convs.filter((c) => c.status === 'PENDING').length },
    { key: 'awaiting', label: t('انتظار العميل'),  count: convs.filter((c) => c.status === 'AWAITING_CLIENT').length },
    { key: 'mine',     label: t('مُسندة لي'),      count: convs.filter((c) => c.assigneeId === currentUser?.id).length },
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
              <div className="flex gap-1 overflow-x-auto pb-1 [&::-webkit-scrollbar]:hidden">
                {STATUS_TABS.map((tab) => (
                  <button
                    key={tab.key}
                    onClick={() => setConvFilter(tab.key)}
                    className={cn(
                      'flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors',
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
                        'rounded-full px-1 text-[10px]',
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
              {PREDEFINED_LABELS.length > 0 && (
                <div className="flex gap-1 overflow-x-auto pb-2 [&::-webkit-scrollbar]:hidden">
                  {PREDEFINED_LABELS.map((lbl) => (
                    <button
                      key={lbl.text}
                      onClick={() => setLabelFilter((f) => f === lbl.text ? null : lbl.text)}
                      className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium transition-opacity"
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

        {/* Search + actions */}
        <div className="border-b border-border px-3 py-2 space-y-2">
          {(
            <>
              <div className="relative">
                <Search className="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input className="h-8 pr-9 text-xs" placeholder={t('بحث...')} value={search} onChange={(e) => {
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
                          name: c.contact?.name || c.contact?.phone || 'غير معروف',
                          phone: c.contact?.phone || '',
                          zoneId: c.contact?.zoneId || '', zoneNameAr: c.contact?.zone?.nameAr || '',
                          status: c.status, ticketId: null, ticketStatus: null, ticketPriority: null,
                          lastMsg: c.messages?.[0]?.body || '', lastTime: '',
                          sessionDate: '', unread: 0, avatar: (c.contact?.name || c.contact?.phone || '؟').charAt(0),
                          assigneeId: c.assignee?.id ?? null, assigneeName: c.assignee?.name ?? null,
                          contactId: c.contact?.id ?? '', contactTags: c.contact?.tags ?? [],
                          contactNotes: c.contact?.notes ?? null, labels: c.labels ?? [],
                        }));
                        setConvs(mapped);
                      } catch { /* ignore */ }
                    }, 300);
                    setSearchDebounceTimer(t2);
                  } else if (val.length === 0) {
                    setIsSearchMode(false);
                    loadConvs(true, convFilter, true);
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
          {filtered.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <MessageSquarePlus className="h-8 w-8 text-muted-foreground/30" />
              <p className="text-xs text-muted-foreground">{t('لا توجد محادثات')}</p>
            </div>
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
                  'relative flex w-full gap-2.5 border-b border-border/40 px-3 py-3 text-right transition-colors hover:bg-accent/40',
                  isActive && 'bg-primary/8 before:absolute before:right-0 before:top-0 before:h-full before:w-0.5 before:bg-primary'
                )}
              >
                <Avatar className="h-9 w-9 shrink-0">
                  {/* Solid fill, white initial — a 12% tint of the same hue put
                      the initial at ~2.9:1 against its own background. */}
                  <AvatarFallback className="text-xs font-bold" style={{ backgroundColor: cz.color, color: '#fff' }}>
                    {c.avatar}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="mb-0.5 flex items-start justify-between gap-1">
                    <span className={cn('truncate text-[13px] font-semibold', isActive ? 'text-foreground' : 'text-foreground/90')}>
                      {c.name}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{c.lastTime}</span>
                  </div>
                  <div className="mb-1 flex items-center gap-1.5">
                    <StatusBadge label={csc.label} color={csc.color} className="px-1.5 py-0 text-[9px]" />
                    {c.assigneeName && (
                      <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
                        <User className="h-2.5 w-2.5" />{c.assigneeName}
                      </span>
                    )}
                  </div>
                  {c.labels.length > 0 && (
                    <div className="mb-0.5 flex flex-wrap gap-0.5">
                      {c.labels.slice(0, 3).map((lbl) => (
                        <span key={lbl} className="rounded-full px-1.5 py-0 text-[9px] font-medium"
                          style={{ backgroundColor: `${labelColor(lbl)}25`, color: labelColor(lbl) }}>
                          {lbl}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-1">
                    <span className="truncate text-[11px] text-muted-foreground">
                      {isClientRating(c.lastMsg) ? `⭐ تقييم ${c.lastMsg}/5` : c.lastMsg}
                    </span>
                    {c.unread > 0 && (
                      <Badge className="h-4 min-w-4 shrink-0 rounded-full px-1 text-[9px]">{c.unread}</Badge>
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
                  <span className="truncate text-sm font-bold">{sel.name}</span>
                  <span className="shrink-0 text-[10px] font-mono text-muted-foreground opacity-60">#{sel.displayId}</span>
                  <StatusBadge label={sc!.label} color={sc!.color} className="shrink-0 px-1.5 py-0 text-[10px]" />
                  {sel.labels.map((lbl) => (
                    <span key={lbl} className="rounded-full px-2 py-0 text-[9px] font-medium cursor-pointer"
                      style={{ backgroundColor: `${labelColor(lbl)}25`, color: labelColor(lbl) }}
                      onClick={() => handleUpdateLabels(sel.labels.filter((l) => l !== lbl))}>
                      {lbl} ×
                    </span>
                  ))}
                  {/* Add label button */}
                  {PREDEFINED_LABELS.length > 0 && <div ref={labelMenuRef} className="relative">
                    <button
                      onClick={() => setLabelMenuOpen((v) => !v)}
                      className="flex items-center gap-0.5 rounded-full border border-border/50 px-1.5 py-0 text-[9px] text-muted-foreground hover:text-foreground transition-colors"
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
                          <p className="px-2 py-1 text-[10px] text-muted-foreground">كل التصنيفات مضافة</p>
                        )}
                      </div>
                    )}
                  </div>}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-muted-foreground" dir="ltr">{sel.phone}</span>
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
                          setMessages((prev) => [...res.messages, ...prev]);
                          setHasMoreMessages(res.hasMore);
                          setOldestMsgId(res.oldestId);
                        } finally { setLoadingOlder(false); }
                      }}
                      disabled={loadingOlder}
                      className="rounded-full border border-border bg-card px-4 py-1.5 text-[11px] text-muted-foreground hover:bg-accent disabled:opacity-50 transition-colors"
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
                      <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold text-warning">
                        <Lock className="h-2.5 w-2.5" />
                        {t('ملاحظة داخلية')}
                      </div>
                    )}
                    {m.auto && !m.isInternal && (
                      <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold text-primary">
                        <Zap className="h-3 w-3" />
                        {m.autoType === 'feedback' ? t('شكر وتقييم') : t('رد تلقائي')}
                      </div>
                    )}
                    {m.dir === 'out' && !m.auto && !m.isInternal && m.sentByName && (
                      <p className="mb-0.5 text-[10px] font-semibold text-primary-foreground/80">{m.sentByName}</p>
                    )}
                    {m.dir === 'in' && isClientRating(m.body) && (
                      <div className="mb-1 text-[10px] font-semibold text-warning">
                        ⭐ {t('تقييم العميل')}: {m.body}/5
                      </div>
                    )}
                    <MessageMedia mediaUrl={m.mediaUrl} mediaType={m.mediaType} />
                    {m.body && !(m.mediaUrl && /^\[.*\]$/.test(m.body)) && <p className="whitespace-pre-wrap">{m.body}</p>}
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <p className="text-[10px] opacity-40">{m.time}</p>
                      {m.dir === 'out' && (
                        <span className="text-[10px] opacity-50">
                          {m.status === 'READ' ? '✓✓' : m.status === 'DELIVERED' ? '✓✓' : m.status === 'SENT' ? '✓' : m.status === 'FAILED' ? '✗' : '○'}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
                <div ref={endRef} />
              </div>
            </ScrollArea>

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
                {sel.status !== 'RESOLVED' && sel.status !== 'AWAITING_CLIENT' && (
                  <Button variant="outline" size="sm" className="h-7 gap-1 text-xs text-indigo-400 border-indigo-500/20 hover:bg-indigo-500/10"
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

            <Composer
              value={reply}
              onChange={(v) => { setReply(v); setSendError(null); }}
              isInternal={isInternalNote}
              onInternalChange={setIsInternalNote}
              onSend={handleSend}
              disabled={!sel}
              error={sendError}
              shortCodeMatches={shortCodeMatches}
              onShortCodeQuery={(q) => {
                if (!q) { setShortCodeMatches([]); return; }
                fetchTemplatesByShortCode(q)
                  .then((m) => { setShortCodeMatches(m); setShortCodeIdx(0); })
                  .catch(() => {});
              }}
              onShortCodePick={expandShortCode}
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
          agents={techs}
          assigning={assigning}
          onAssign={handleAssign}
          onClose={() => setShowDetails(false)}
          currentUserId={currentUser?.id}
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
              <p className="text-[11px] text-muted-foreground">{t('الصيغ المدعومة: 0501234567 أو +972501234567')}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-name" className="text-xs">{t('اسم العميل (اختياري)')}</Label>
              <Input id="new-name" placeholder={t('مثال: أحمد محمد')}
                value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleStartChat()} />
            </div>
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
              <strong className="text-foreground">{sel.name}</strong>.
            </p>
          )}
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button className="w-full" onClick={handleResolve}>
              <CheckCircle2 className="ml-1 h-3.5 w-3.5" />
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
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{tpl.body}</p>
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
