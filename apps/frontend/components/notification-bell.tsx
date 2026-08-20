'use client';

import { useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { fetchNotifications, markAllNotificationsRead, markNotificationRead, type AppNotification } from '@/lib/data';
import { getSocket } from '@/lib/socket';

export function NotificationBell() {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const load = () =>
    fetchNotifications().then(({ notifications: n, unreadCount }) => {
      setNotifications(n);
      setUnread(unreadCount);
    }).catch(() => {});

  useEffect(() => {
    load();
    // Close on outside click
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Real-time push
  useEffect(() => {
    const s = getSocket();
    const handler = (payload: { notification: AppNotification; unreadCount: number }) => {
      setNotifications((prev) => [payload.notification, ...prev].slice(0, 50));
      setUnread(payload.unreadCount);
    };
    s.on('notification', handler);
    return () => { s.off('notification', handler); };
  }, []);

  const handleClick = async (n: AppNotification) => {
    if (!n.isRead) {
      const newCount = await markNotificationRead(n.id);
      setUnread(newCount);
      setNotifications((prev) => prev.map((x) => x.id === n.id ? { ...x, isRead: true } : x));
    }
    if (n.conversationId) {
      router.push(`/inbox?conv=${n.conversationId}`);
      setOpen(false);
    }
  };

  const handleReadAll = async () => {
    await markAllNotificationsRead();
    setUnread(0);
    setNotifications((prev) => prev.map((x) => ({ ...x, isRead: true })));
  };

  const typeIcon: Record<string, string> = {
    NEW_MESSAGE: '💬',
    CONVERSATION_ASSIGNED: '👤',
    CONVERSATION_RESOLVED: '✅',
    MENTION: '@',
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[9px] font-bold text-primary-foreground">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-10 z-50 w-80 rounded-xl border border-border bg-card shadow-xl" dir="rtl">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <span className="text-sm font-semibold">الإشعارات</span>
            {unread > 0 && (
              <button onClick={handleReadAll} className="text-[11px] text-primary hover:underline">
                قراءة الكل
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 && (
              <p className="py-8 text-center text-xs text-muted-foreground">لا توجد إشعارات</p>
            )}
            {notifications.map((n) => (
              <button
                key={n.id}
                onClick={() => handleClick(n)}
                className={`w-full text-right px-4 py-3 flex gap-3 items-start hover:bg-secondary/50 transition-colors border-b border-border/40 last:border-0 ${!n.isRead ? 'bg-primary/5' : ''}`}
              >
                <span className="text-base shrink-0 mt-0.5">{typeIcon[n.type] || '🔔'}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold leading-snug">{n.title}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{n.body}</p>
                  {n.conversation && (
                    <p className="mt-0.5 text-[10px] text-muted-foreground opacity-60">#{n.conversation.displayId}</p>
                  )}
                </div>
                {!n.isRead && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
