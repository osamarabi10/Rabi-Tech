'use client';

import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ArchiveRestore, AtSign, Bell, CircleCheck, MessageCircle, UserRoundCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  archiveAllNotifications,
  archiveNotification,
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  restoreNotification,
  type AppNotification,
  type NotificationScope,
} from '@/lib/data';
import { getSocket } from '@/lib/socket';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { EmptyState, ErrorState, SkeletonBlock } from '@/components/ui/operational-state';
import { notifyWithUndo } from '@/components/ui/toast';

const NOTIFICATION_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  NEW_MESSAGE: MessageCircle,
  CONVERSATION_ASSIGNED: UserRoundCheck,
  CONVERSATION_RESOLVED: CircleCheck,
  MENTION: AtSign,
};

const SCOPES: Array<{ value: NotificationScope; label: string }> = [
  { value: 'new', label: 'الجديدة' },
  { value: 'archived', label: 'المؤرشفة' },
  { value: 'all', label: 'الكل' },
];

function playNotificationSound() {
  try {
    const user = JSON.parse(localStorage.getItem('rabitech_user') || '{}');
    if (user.notificationSound === false) return;
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 660;
    gain.gain.setValueAtTime(0.04, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.12);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.12);
    oscillator.addEventListener('ended', () => context.close());
  } catch {
    // Browsers can reject audio before the first user interaction. The visual
    // notification still arrives, so sound failure is intentionally non-fatal.
  }
}

export function NotificationBell() {
  const { t } = useT();
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [scope, setScope] = useState<NotificationScope>('new');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const router = useRouter();

  const load = useCallback(async (nextScope: NotificationScope) => {
    setLoading(true);
    setLoadError(false);
    try {
      const result = await fetchNotifications(nextScope);
      setNotifications(result.notifications);
      setUnread(result.unreadCount);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load('new'); }, [load]);

  useEffect(() => {
    if (open) load(scope);
  }, [load, open, scope]);

  useEffect(() => {
    const handlePointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, []);

  useEffect(() => {
    const socket = getSocket();
    const handleNotification = (payload: { notification: AppNotification; unreadCount: number }) => {
      if (scope !== 'archived') setNotifications((current) => [payload.notification, ...current].slice(0, 50));
      setUnread(payload.unreadCount);
      playNotificationSound();
    };
    socket.on('notification', handleNotification);
    return () => { socket.off('notification', handleNotification); };
  }, [scope]);

  const handleClick = async (notification: AppNotification) => {
    if (!notification.isRead) {
      const newCount = await markNotificationRead(notification.id);
      setUnread(newCount);
      setNotifications((current) => current.map((item) => item.id === notification.id ? { ...item, isRead: true } : item));
    }
    if (notification.conversationId) {
      router.push(`/inbox?conversation=${notification.conversationId}`);
      setOpen(false);
    }
  };

  const handleReadAll = async () => {
    await markAllNotificationsRead();
    setUnread(0);
    setNotifications((current) => current.map((item) => ({ ...item, isRead: true })));
  };

  const handleArchiveAll = async () => {
    await archiveAllNotifications();
    setUnread(0);
    setNotifications(scope === 'all' ? (current) => current.map((item) => ({ ...item, isRead: true, archivedAt: new Date().toISOString() })) : []);
  };

  const handleArchive = async (notification: AppNotification) => {
    const newCount = await archiveNotification(notification.id);
    setUnread(newCount);
    if (scope === 'all') {
      setNotifications((current) => current.map((item) => item.id === notification.id ? { ...item, isRead: true, archivedAt: new Date().toISOString() } : item));
    } else {
      setNotifications((current) => current.filter((item) => item.id !== notification.id));
    }

    /*
      P19, in `inverse` mode rather than `defer`.

      The archive call has already happened by the time we are here, because
      this handler needs its return value — the server's new unread count — to
      update the badge. That is precisely the case the deferred mode cannot
      serve, and precisely why the escape hatch exists.

      Being inverse mode means this undo can fail, and the toast is required to
      say so rather than vanish: `undoFailed` names what is still true, not a
      generic apology.
    */
    notifyWithUndo(t('تمت أرشفة الإشعار'), {
      undo: {
        mode: 'inverse',
        inverse: async () => {
          const restoredCount = await restoreNotification(notification.id);
          setUnread(restoredCount);
          if (scope === 'all') {
            setNotifications((current) => current.map((item) => item.id === notification.id ? { ...item, archivedAt: null } : item));
          } else {
            setNotifications((current) => [notification, ...current.filter((item) => item.id !== notification.id)]);
          }
        },
      },
      labels: {
        undo: t('تراجع'),
        undoing: t('جارٍ التراجع…'),
        undone: t('تمت استعادة الإشعار'),
        undoFailed: t('تعذّر التراجع — الإشعار ما زال مؤرشفًا'),
        retry: t('إعادة المحاولة'),
        commitFailed: t('تعذّر إتمام الإجراء'),
      },
    });
  };

  const handleRestore = async (notification: AppNotification) => {
    const newCount = await restoreNotification(notification.id);
    setUnread(newCount);
    if (scope === 'all') {
      setNotifications((current) => current.map((item) => item.id === notification.id ? { ...item, archivedAt: null } : item));
    } else {
      setNotifications((current) => current.filter((item) => item.id !== notification.id));
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={unread > 0 ? `${t('الإشعارات')} (${unread})` : t('الإشعارات')}
        className="relative flex h-8 w-8 items-center justify-center rounded-md text-nav-muted transition-colors motion-micro hover:bg-nav-accent/60 hover:text-nav-foreground"
      >
        <Bell className="h-4 w-4" aria-hidden />
        {unread > 0 && <span className="absolute -top-0.5 -end-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-micro font-bold text-primary-foreground">{unread > 9 ? '9+' : unread}</span>}
      </button>

      {open && createPortal(
        <section
          ref={panelRef}
          role="dialog"
          aria-label={t('الإشعارات')}
          className="fixed bottom-4 start-14 z-[100] flex max-h-[70vh] w-[min(22rem,calc(100vw-4rem))] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl"
        >
          <header className="border-b border-border px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">{t('الإشعارات')}</h2>
              <div className="flex items-center gap-2">
                {unread > 0 && <button type="button" onClick={handleReadAll} className="text-caption text-primary hover:underline">{t('قراءة الكل')}</button>}
                {scope === 'new' && notifications.length > 0 && <button type="button" onClick={handleArchiveAll} className="text-caption text-primary hover:underline">{t('أرشفة الكل')}</button>}
              </div>
            </div>
            <div role="tablist" aria-label={t('عرض الإشعارات')} className="mt-2 grid grid-cols-3 rounded-md bg-muted p-0.5">
              {SCOPES.map((item) => (
                <button key={item.value} type="button" role="tab" aria-selected={scope === item.value} onClick={() => setScope(item.value)} className={cn('rounded px-2 py-1 text-caption font-medium text-muted-foreground', scope === item.value && 'bg-card text-foreground shadow-sm')}>
                  {t(item.label)}
                </button>
              ))}
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading && <div className="space-y-2 p-3" aria-label={t('جاري التحميل...')}>{Array.from({ length: 4 }).map((_, index) => <SkeletonBlock key={index} className="h-16" />)}</div>}
            {!loading && loadError && <ErrorState compact title={t('تعذر تحميل الإشعارات')} retryLabel={t('إعادة المحاولة')} onRetry={() => load(scope)} />}
            {!loading && !loadError && notifications.length === 0 && <EmptyState compact icon={Bell} title={t('لا توجد إشعارات')} />}
            {!loading && !loadError && notifications.map((notification) => {
              const TypeIcon = NOTIFICATION_ICONS[notification.type] || Bell;
              return (
                <article key={notification.id} className={cn('flex items-start gap-2 border-b border-border/60 px-3 py-2.5 last:border-0', !notification.isRead && 'bg-primary/5')}>
                  <TypeIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <button type="button" onClick={() => handleClick(notification)} className="min-w-0 flex-1 text-start">
                    <span className="block text-xs font-semibold leading-snug" dir="auto">{notification.title}</span>
                    <span className="mt-0.5 block text-caption text-muted-foreground" dir="auto">{notification.body}</span>
                    {notification.conversation && <span className="numeric mt-0.5 block text-micro text-muted-foreground" dir="ltr">#{notification.conversation.displayId}</span>}
                  </button>
                  <button type="button" onClick={() => notification.archivedAt ? handleRestore(notification) : handleArchive(notification)} aria-label={notification.archivedAt ? t('استعادة') : t('أرشفة')} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                    {notification.archivedAt ? <ArchiveRestore className="size-3.5" aria-hidden /> : <Archive className="size-3.5" aria-hidden />}
                  </button>
                  {!notification.isRead && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-label={t('جديد')} />}
                </article>
              );
            })}
          </div>
        </section>
      , document.body)}
    </div>
  );
}
