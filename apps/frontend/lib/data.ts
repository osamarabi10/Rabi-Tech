// Data layer — always uses the live backend API.
import api from './api';
import { formatTimeOfDay } from './format-time';

// ---------- UI types ----------
export type MarketingConsent = 'UNKNOWN' | 'OPTED_IN' | 'OPTED_OUT';

export type Conv = {
  id: string;
  displayId: number;
  teamId: string | null;
  teamName: string | null;
  name: string;
  phone: string;
  status: string;
  lastMsg: string;
  lastTime: string;
  sessionDate: string;
  unread: number;
  avatar: string;
  assigneeId: string | null;
  assigneeName: string | null;
  contactId: string;
  contactTags: string[];
  contactNotes: string | null;
  /** Marketing consent. OPTED_OUT contacts are excluded from every broadcast. */
  marketingConsent: MarketingConsent;
  /**
   * Free text, matched against the tenant's configured stages by name. A
   * contact can hold a value no longer in that list — see LifecycleSelect.
   */
  lifecycleStage: string | null;
  /**
   * The WhatsApp session this thread sends from.
   *
   * The backend has always included it; nothing carried it to the client. The
   * composer needs it to say which number a reply will leave from, and to check
   * whether that specific session is connected.
   */
  sessionName: string | null;
  /** Hidden from the queue while this is in the future. Null when awake. */
  snoozedUntil?: string | null;
  snoozedByName?: string | null;
  /**
   * When an agent first replied to this customer, or null if nobody has.
   *
   * Null is the useful half: it is what an unanswered view is built on, and
   * why this had to reach the client before such a view could exist. A filter
   * for a field the client never received would match every conversation and
   * look like it was working.
   *
   * The backend stamps it on the first human, customer-facing reply only.
   * Auto-replies and internal notes leave it null on purpose — an auto-reply
   * would mark every thread answered within seconds of arriving, which is the
   * opposite of what anyone opening that view wants to see.
   */
  firstResponseAt: string | null;
  sessionPhone: string | null;
  labels: string[];
};

/**
 * Stand-in for a contact with neither a name nor a usable phone number.
 *
 * The value is the Arabic source string, which is also its dictionary key —
 * that is how every UI string in this app works. What makes it different from
 * the rest is that it is produced in the data layer, where there is no `t()`,
 * so it reached the screen untranslated and a Hebrew workspace showed one
 * Arabic phrase in the middle of its conversation list. Display sites compare
 * against this and translate; a real contact called something else passes
 * through untouched.
 */
export const UNKNOWN_CONTACT = 'غير معروف';

/** The contact's name as it should be shown, placeholder translated. */
export function contactDisplayName(name: string, t: (key: string) => string): string {
  return name === UNKNOWN_CONTACT ? t(UNKNOWN_CONTACT) : name;
}

export type Msg = {
  id: string;
  dir: 'in' | 'out';
  body: string;
  time: string;
  auto: boolean;
  autoType?: string | null;
  mediaUrl?: string | null;
  mediaType?: string | null;
  sentByName?: string | null;
  status?: 'PENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
  /** Why the last send attempt failed. Only ever set alongside FAILED. */
  failureReason?: string | null;
  isInternal?: boolean;
};

export type AppNotification = {
  id: string;
  type: string;
  conversationId: string | null;
  title: string;
  body: string;
  isRead: boolean;
  createdAt: string;
  conversation?: { displayId: number; teamId: string | null; team?: { id: string; name: string } | null } | null;
};

export type Campaign = {
  id: string;
  title: string;
  audience: string;
  status: string;
  recipients: number;
  date: string;
};

export type Contact = {
  id: string;
  name: string;
  phone: string;
  tags: string[];
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  language?: string | null;
  profilePic?: string | null;
  countryCode?: string | null;
  lifecycleStage?: string | null;
  assigneeId?: string | null;
  assigneeName?: string | null;
  notes?: string | null;
  marketingConsent?: MarketingConsent;
  customFields?: Record<string, string | null>;
};

/**
 * Mirror of the backend rule type. `value` is `unknown` rather than `string`
 * deliberately: numeric and date operators carry numbers and ISO strings, and a
 * `string`-only type here would have fought every one of them.
 */
export type ContactFilterRule = {
  category: 'contactField' | 'tag' | 'customField';
  field: string;
  operator: string;
  value?: unknown;
  /** Second operand for range operators (`between`). */
  value2?: unknown;
};

/** A group nests another set of nodes under its own AND/OR, to the depth the server allows. */
export type ContactFilterNode = ContactFilterRule | ContactFilterDsl;
export type ContactFilterDsl = { $and?: ContactFilterNode[]; $or?: ContactFilterNode[] };

export type CrmTag = {
  id: string;
  name: string;
  description?: string | null;
  colorCode?: string | null;
  emoji?: string | null;
};

export type CustomFieldDefinition = {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  dataType: 'text' | 'number' | 'date' | 'list';
  allowedValues: string[];
};

export type Stats = {
  conversations?: {
    open: number;
    pending: number;
    resolvedToday: number;
    resolved: number;
    campaignsSent: number;
  };
};

export type Agent = { id: string; name: string; team: string; avail: boolean };
export type SystemUser = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  primaryTeamId?: string | null;
  primaryTeam?: { id: string; name: string; slug: string; color: string } | null;
  teams?: Array<{ teamId: string; team?: { id: string; name: string; slug: string; color: string } }>;
  role: string;
  isActive: boolean;
  isAway: boolean;
  createdAt: string;
};
export type Session = {
  sessionName: string;
  label: string;
  connected: boolean;
  /**
   * The linked number, or null when this session has never been paired.
   *
   * Carried so a disconnected channel can say which kind of disconnected it
   * is: never scanned (needs a QR) or dropped after pairing (needs a
   * reconnect, which the gateway often does by itself).
   */
  phoneNumber: string | null;
};
export type InboxConfig = {
  sessions: { id: string; sessionName: string; label: string | null; phoneNumber: string | null; teamId: string | null }[];
};

export type Template = {
  id: string;
  title: string;
  body: string;
  category: 'QUICK_REPLY' | 'AUTO_REPLY' | 'CAMPAIGN' | 'OUTAGE' | 'OUT_OF_HOURS';
  teamId?: string | null;
  team?: { id: string; name: string; slug: string; color: string } | null;
  sortOrder: number;
  isActive: boolean;
  shortCode?: string | null;
};

export type AgentStat = {
  name: string;
  team?: { id: string; name: string; slug: string; color: string } | null;
  messagesSent: number;
  conversationsHandled: number;
  resolvedCount: number;
  avgFirstResponseMinutes: number | null;
  csatAvg: number | null;
  csatCount: number;
};

export type WorkingHours = {
  enabled: boolean;
  autoReplyEnabled: boolean;
  timezone: string;
  workDays: number[];
  startTime: string;
  endTime: string;
  outOfHoursTemplateId: string | null;
  outOfHoursTemplate?: Template | null;
  welcomeTemplateId: string | null;
  welcomeTemplate?: Template | null;
  isOpenNow?: boolean;
};

export type SessionQR = {
  connected: boolean;
  qrCode?: string;
  pending?: boolean;
  /** Raw gateway state, for accurate UI messaging. */
  state?: string;
  /**
   * True when the gateway still holds saved credentials and is reconnecting the
   * same number. No QR will be offered — to pair a different phone the admin
   * must unlink this device from WhatsApp on the phone itself.
   */
  reconnecting?: boolean;
};

export type UsageMetric =
  | 'messages_inbound'
  | 'messages_outbound'
  | 'active_contacts'
  | 'ai_tokens_in'
  | 'ai_tokens_out'
  | 'campaign_sends';

export type UsageItem = {
  metric: UsageMetric;
  current: string;
  limit: string | null;
  percent: number | null;
  state: 'normal' | 'warning' | 'exceeded' | 'unlimited';
};

export type CurrentUsage = {
  period: { start: string; end: string };
  items: UsageItem[];
};

// ---------- helpers ----------
function fmtTime(iso?: string | null): string {
  if (!iso) return '';
  return formatTimeOfDay(iso);
}

function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toISOString().slice(0, 10);
}

function ticketLabel(title: string, id: string): string {
  const m = title?.match(/\[(T-\d+)\]/);
  return m ? m[1] : id.slice(-6).toUpperCase();
}

function formatPhone(phone: string): string {
  if (!phone) return '';
  // Strip WhatsApp suffixes (@c.us, @s.whatsapp.net, @lid, @broadcast, etc.)
  const clean = phone.replace(/@.+$/, '').replace(/^\+?/, '');
  if (!clean || clean === 'status') return phone; // keep special IDs as-is
  return `+${clean}`;
}

// ---------- conversations ----------
export async function startConversation(input: {
  phone: string;
  name?: string;
  message?: string;
  teamId?: string | null;
}): Promise<Conv> {
  const { data } = await api.post('/api/conversations/start', {
    phone: input.phone,
    name: input.name,
    message: input.message,
    teamId: input.teamId || undefined,
  });
  return {
    id: data.id,
    displayId: data.displayId ?? 0,
    teamId: data.teamId ?? data.session?.teamId ?? null,
    teamName: data.team?.name ?? data.session?.team?.name ?? null,
    name: data.contact?.name || formatPhone(data.contact?.phone) || UNKNOWN_CONTACT,
    phone: formatPhone(data.contact?.phone),
    status: data.status,
    lastMsg: data.messages?.[0]?.body || '',
    lastTime: fmtTime(data.lastMessageAt),
    sessionDate: fmtDate(data.createdAt),
    unread: data._count?.messages ?? 0,
    // ASCII '?', not the Arabic '؟'. It is a placeholder glyph, not a
    // sentence — a Hebrew or English workspace should not get an Arabic
    // question mark in its avatar circle, and no locale needs a translated one.
    avatar: (data.contact?.name || data.contact?.phone || '?').charAt(0),
    assigneeId: data.assignee?.id ?? null,
    assigneeName: data.assignee?.name ?? null,
    contactId: data.contact?.id ?? '',
    contactTags: data.contact?.tags ?? [],
    contactNotes: data.contact?.notes ?? null,
    marketingConsent: data.contact?.marketingConsent ?? 'UNKNOWN',
    lifecycleStage: data.contact?.lifecycleStage ?? null,
    sessionName: data.session?.sessionName ?? null,
    snoozedUntil: data.snoozedUntil ?? null,
    snoozedByName: data.snoozedByName ?? null,
    firstResponseAt: data.firstResponseAt ?? null,
    sessionPhone: data.session?.phoneNumber ?? null,
    labels: data.labels ?? [],
  };
}

export async function fetchConversations(
  opts?: { includeResolved?: boolean }
): Promise<Conv[]> {
  const { data } = await api.get('/api/conversations', {
    params: {
      activeOnly: opts?.includeResolved ? 'false' : 'true',
    },
  });
  return data.map((c: any): Conv => ({
    id: c.id,
    displayId: c.displayId ?? 0,
    teamId: c.teamId ?? c.session?.teamId ?? null,
    teamName: c.team?.name ?? c.session?.team?.name ?? null,
    name: c.contact?.name || formatPhone(c.contact?.phone) || UNKNOWN_CONTACT,
    phone: formatPhone(c.contact?.phone),
    status: c.status,
    lastMsg: c.messages?.[0]?.body || '',
    lastTime: fmtTime(c.lastMessageAt),
    sessionDate: fmtDate(c.createdAt),
    unread: c._count?.messages ?? 0,
    avatar: (c.contact?.name || c.contact?.phone || '?').charAt(0),
    assigneeId: c.assignee?.id ?? null,
    assigneeName: c.assignee?.name ?? null,
    contactId: c.contact?.id ?? '',
    contactTags: c.contact?.tags ?? [],
    contactNotes: c.contact?.notes ?? null,
    marketingConsent: c.contact?.marketingConsent ?? 'UNKNOWN',
    lifecycleStage: c.contact?.lifecycleStage ?? null,
    sessionName: c.session?.sessionName ?? null,
    snoozedUntil: c.snoozedUntil ?? null,
    snoozedByName: c.snoozedByName ?? null,
    firstResponseAt: c.firstResponseAt ?? null,
    sessionPhone: c.session?.phoneNumber ?? null,
    labels: c.labels ?? [],
  }));
}

function mapMsg(m: any): Msg {
  return {
    id: m.id,
    dir: m.direction === 'INBOUND' ? 'in' : 'out',
    body: m.body || '',
    time: fmtTime(m.timestamp),
    auto: !!m.isAuto,
    autoType: m.autoType ?? null,
    mediaUrl: m.mediaUrl ?? null,
    mediaType: m.mediaType ?? null,
    sentByName: m.sentBy?.name ?? null,
    status: m.status ?? undefined,
    failureReason: m.failureReason ?? null,
    isInternal: m.isInternal ?? false,
  };
}

export async function fetchMessages(convId: string): Promise<{ messages: Msg[]; hasMore: boolean; oldestId: string | null }> {
  const { data } = await api.get(`/api/conversations/${convId}/messages`);
  // Support both old array response and new paginated response
  const raw = Array.isArray(data) ? data : data.messages ?? [];
  return {
    messages: raw.map(mapMsg),
    hasMore: Array.isArray(data) ? false : (data.hasMore ?? false),
    oldestId: Array.isArray(data) ? null : (data.oldestId ?? null),
  };
}

export async function fetchOlderMessages(convId: string, beforeId: string): Promise<{ messages: Msg[]; hasMore: boolean; oldestId: string | null }> {
  const { data } = await api.get(`/api/conversations/${convId}/messages`, { params: { before: beforeId } });
  const raw = Array.isArray(data) ? data : data.messages ?? [];
  return {
    messages: raw.map(mapMsg),
    hasMore: Array.isArray(data) ? false : (data.hasMore ?? false),
    oldestId: Array.isArray(data) ? null : (data.oldestId ?? null),
  };
}

export async function fetchNotifications(unreadOnly = false): Promise<{ notifications: AppNotification[]; unreadCount: number }> {
  const { data } = await api.get('/api/notifications', { params: unreadOnly ? { unread: 'true' } : {} });
  return data;
}

export async function markNotificationRead(id: string): Promise<number> {
  const { data } = await api.patch(`/api/notifications/${id}/read`);
  return data.unreadCount;
}

export async function markAllNotificationsRead(): Promise<void> {
  await api.patch('/api/notifications/read-all');
}

export function isClientRating(body: string): boolean {
  const raw = body.trim().replace(/[١٢٣٤٥]/g, (d) => ({ '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5' })[d] || d);
  return /^[1-5]$/.test(raw);
}

export async function sendReply(
  convId: string,
  body: string,
  isInternal = false,
  /** Resolved teammate ids, never names parsed out of the text. */
  mentionedUserIds: string[] = [],
): Promise<Msg> {
  const { data } = await api.post(`/api/conversations/${convId}/reply`, {
    body,
    isInternal,
    mentionedUserIds,
  });
  return {
    id: data.id,
    dir: 'out',
    body: data.body || '',
    time: fmtTime(data.timestamp),
    auto: false,
    isInternal: data.isInternal ?? false,
    status: data.status,
  };
}

export async function updateConversationLabels(convId: string, labels: string[]): Promise<void> {
  await api.patch(`/api/conversations/${convId}/labels`, { labels });
}

export async function fetchTemplatesByShortCode(prefix: string): Promise<Template[]> {
  const { data } = await api.get('/api/templates', { params: { shortCode: prefix, active: 'true' } });
  return data;
}

export async function fetchAgentPerformance(params?: { startDate?: string; endDate?: string }): Promise<AgentStat[]> {
  const { data } = await api.get('/api/analytics/agents', { params });
  return data;
}

export async function updateConversation(
  convId: string,
  patch: { status?: string; assignedToId?: string | null }
): Promise<void> {
  await api.patch(`/api/conversations/${convId}`, patch);
}

// ---------- tickets ----------

// ---------- campaigns ----------
export async function fetchCampaigns(): Promise<Campaign[]> {
  const { data } = await api.get('/api/campaigns');
  return data.map((c: any): Campaign => ({
    id: c.id,
    title: c.title,
    audience: c.audienceLabel || 'كل جهات الاتصال',
    status: c.status,
    recipients: c._count?.recipients ?? 0,
    date: fmtDate(c.sentAt || c.createdAt),
  }));
}

/** Resolved audience for a filter, shown before anything is sent. */
export async function previewCampaignAudience(
  audienceFilter: ContactFilterDsl | null,
): Promise<{
  count: number;
  sample: Array<{ id: string; name: string | null; phone: string; firstName: string | null }>;
  /**
   * Contacts the filter matched but consent removed.
   *
   * The server has always computed this and the client has always thrown it
   * away, which is how an audience could shrink by six hundred people with
   * nothing on screen saying why. An unexplained drop reads as a broken filter,
   * and the usual response to a broken filter is to work around it.
   */
  excludedOptedOut: number;
}> {
  const { data } = await api.post('/api/campaigns/audience/preview', { audienceFilter });
  return data;
}

/**
 * Creates the campaign as a DRAFT. Sending is a separate, explicit call —
 * a broadcast cannot be taken back once it leaves, so it never rides along
 * with "create".
 */
export async function createCampaign(input: {
  title: string;
  message: string;
  audienceFilter?: ContactFilterDsl | null;
  scheduledAt?: string | null;
}): Promise<{ id: string; recipientCount: number }> {
  const { data } = await api.post('/api/campaigns', input);
  return { id: data.id, recipientCount: data.recipientCount ?? 0 };
}

export async function sendCampaign(id: string): Promise<{ queued: number }> {
  const { data } = await api.post(`/api/campaigns/${id}/send`);
  return data;
}

export type CampaignReport = {
  campaign: { id: string; title: string; status: string; sentAt: string | null; scheduledAt: string | null };
  total: number;
  counts: { pending: number; sent: number; delivered: number; read: number; failed: number };
  failures: Array<{ id: string; error: string | null; contact: { name: string | null; phone: string } }>;
};

export async function fetchCampaignReport(id: string): Promise<CampaignReport> {
  const { data } = await api.get(`/api/campaigns/${id}/report`);
  return data;
}


// ---------- contacts ----------
function mapContact(c: any): Contact {
  return {
    id: c.id,
    name: c.name || [c.firstName, c.lastName].filter(Boolean).join(' ') || formatPhone(c.phone),
    phone: formatPhone(c.phone),
    tags: c.contactTags?.length ? c.contactTags.map((row: any) => row.tag.name) : c.tags || [],
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    language: c.language,
    profilePic: c.profilePic,
    countryCode: c.countryCode,
    lifecycleStage: c.lifecycleStage,
    assigneeId: c.assigneeId,
    assigneeName: c.assignee?.name || null,
    notes: c.notes,
    customFields: Object.fromEntries((c.customFieldValues || []).map((row: any) => [row.fieldDefinition.slug, row.value])),
  };
}


export async function fetchContactsPage(params: {
  search?: string;
  zone?: string;
  filter?: ContactFilterDsl;
  cursorId?: string | null;
  limit?: number;
}): Promise<{ items: Contact[]; pagination: { cursorId: string | null; hasMore: boolean } }> {
  const { data } = await api.get('/api/contacts', {
    params: {
      paginated: '1',
      search: params.search || undefined,
      zone: params.zone || undefined,
      filter: params.filter ? JSON.stringify(params.filter) : undefined,
      cursorId: params.cursorId || undefined,
      limit: params.limit,
    },
  });
  return { items: data.items.map(mapContact), pagination: data.pagination };
}

export async function updateContact(id: string, input: Partial<Contact>): Promise<Contact> {
  const { data } = await api.patch(`/api/contacts/${id}`, input);
  return mapContact(data);
}

export async function fetchCrmTags(): Promise<CrmTag[]> {
  const { data } = await api.get('/api/contacts/tags');
  return data;
}

export async function saveCrmTag(input: Partial<CrmTag> & { name: string }): Promise<CrmTag> {
  const { data } = await api.post('/api/contacts/tags', input);
  return data;
}

export async function fetchCustomFieldDefinitions(): Promise<CustomFieldDefinition[]> {
  const { data } = await api.get('/api/contacts/custom-fields');
  return data;
}

export async function bulkUpdateContacts(input: {
  contactIds: string[];
  tagName?: string;
  assigneeId?: string | null;
}): Promise<void> {
  await api.post('/api/contacts/bulk', input);
}

export async function mergeContacts(primaryContactId: string, secondaryContactId: string): Promise<Contact> {
  const { data } = await api.post('/api/contacts/merge', { primaryContactId, secondaryContactId });
  return mapContact(data);
}

// ---------- system ----------
export async function fetchStats(): Promise<Stats> {
  const { data } = await api.get('/api/system/stats');
  return data;
}

export async function fetchAgents(): Promise<Agent[]> {
  const { data } = await api.get('/api/system/users');
  return data.map((u: any): Agent => ({ id: u.id, name: u.name, team: u.primaryTeam?.name || '', avail: u.isActive }));
}

export async function fetchSystemUsers(): Promise<SystemUser[]> {
  const { data } = await api.get('/api/system/users', { params: { all: 'true' } });
  return data;
}

/** Seat consumption against the plan's allowance. `limit: null` = unlimited. */
export type SeatUsage = {
  plan: string;
  planName: string;
  used: number;
  limit: number | null;
  remaining: number | null;
  atLimit: boolean;
};

export async function fetchSeatUsage(): Promise<SeatUsage> {
  const { data } = await api.get('/api/usage/seats');
  return data;
}

export async function createSystemUser(input: {
  name: string; email: string; password: string;
  primaryTeamId?: string | null; teamIds?: string[]; role: string; phone?: string;
}): Promise<SystemUser> {
  const { data } = await api.post('/api/system/users', input);
  return data;
}

export async function updateSystemUser(id: string, input: {
  name?: string; email?: string; password?: string;
  primaryTeamId?: string | null; teamIds?: string[]; role?: string; phone?: string; isActive?: boolean;
}): Promise<SystemUser> {
  const { data } = await api.patch(`/api/system/users/${id}`, input);
  return data;
}

export async function deleteSystemUser(id: string): Promise<void> {
  await api.delete(`/api/system/users/${id}`);
}

export async function fetchSessions(): Promise<Session[]> {
  const { data } = await api.get('/api/system/sessions');
  return data.map((s: any): Session => ({
    sessionName: s.sessionName,
    label: s.label,
    connected: !!s.connected,
    phoneNumber: s.phoneNumber ?? null,
  }));
}

export async function fetchSessionQR(sessionName: string): Promise<SessionQR> {
  const { data } = await api.get(`/api/system/sessions/${sessionName}/qr`);
  return data;
}

/**
 * Signs WhatsApp out of this session so a different number can be paired.
 * Conversation history stays — it belongs to the organization, not the phone.
 */
export async function disconnectSession(
  sessionName: string,
  opts: { unlink?: boolean } = {},
): Promise<void> {
  await api.post(`/api/system/sessions/${sessionName}/disconnect`, {
    unlink: opts.unlink === true,
  });
}

export async function fetchInboxConfig(): Promise<InboxConfig> {
  const { data } = await api.get('/api/system/inbox-config');
  return data;
}


let inboxSessions: InboxConfig['sessions'] | null = null;


export function defaultSessionName(sessions?: InboxConfig['sessions']): string {
  const list = sessions ?? inboxSessions;
  return list?.[0]?.sessionName || 'default';
}

export async function fetchTemplates(params?: {
  category?: string;
  teamId?: string | null;
  /** Management screens need disabled snippets too; pickers do not. */
  includeInactive?: boolean;
}): Promise<Template[]> {
  const { includeInactive, ...rest } = params || {};
  const { data } = await api.get('/api/templates', {
    params: { ...rest, ...(includeInactive ? {} : { active: 'true' }) },
  });
  return data;
}

export async function saveTemplate(input: {
  id?: string;
  title: string;
  body: string;
  category: Template['category'];
  teamId?: string | null;
  shortCode?: string | null;
  isActive?: boolean;
}): Promise<Template> {
  if (input.id) {
    const { data } = await api.patch(`/api/templates/${input.id}`, input);
    return data;
  }
  const { data } = await api.post('/api/templates', input);
  return data;
}

export async function fetchWorkingHours(): Promise<WorkingHours> {
  const { data } = await api.get('/api/system/working-hours');
  return data;
}

export async function fetchCurrentUsage(): Promise<CurrentUsage> {
  const { data } = await api.get('/api/usage/current');
  return data;
}

export type OrganizationBranding = {
  productName: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryHsl: string;
  accentHsl: string;
  defaultLocale: 'ar' | 'he' | 'en';
  direction: 'rtl' | 'ltr';
  customDomain: string | null;
  customFooter: string | null;
  tier: string;
  footerText: string;
  canCustomizeFooter: boolean;
  customDomainVerificationToken: string | null;
  customDomainVerifiedAt: string | null;
  customDomainVerificationRecord: string | null;
  customDomainVerified: boolean;
};

export async function fetchOrganizationBranding(): Promise<OrganizationBranding> {
  const { data } = await api.get('/api/branding/current');
  return data;
}

export async function saveOrganizationBranding(
  input: Partial<OrganizationBranding>,
): Promise<OrganizationBranding> {
  const { data } = await api.patch('/api/branding/current', input);
  return data;
}

export type BrandingDomainVerification = {
  customDomain: string | null;
  verified: boolean;
  verifiedAt?: string | null;
  token: string | null;
  record: string | null;
  status?: string;
};

export async function fetchBrandingDomainVerification(): Promise<BrandingDomainVerification> {
  const { data } = await api.get('/api/branding/current/domain-verification');
  return data;
}

export async function uploadBrandingAsset(kind: 'logo' | 'favicon', file: File): Promise<OrganizationBranding> {
  const { data } = await api.post(`/api/branding/current/${kind}`, file, {
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
  });
  return data;
}

export async function saveWorkingHours(input: Partial<WorkingHours>): Promise<WorkingHours> {
  const { data } = await api.patch('/api/system/working-hours', input);
  return {
    ...data,
    welcomeTemplateId: data.welcomeTemplateId ?? null,
  };
}

export async function deleteTemplate(id: string): Promise<void> {
  await api.delete(`/api/templates/${id}`);
}


export type KeywordCategory =
  | 'CRITICAL'
  | 'HIGH'
  | 'MEDIUM'
  | 'LOW'
  | 'LEAD_SALES'
  | 'LEAD_INSTALL'
  | 'LEAD_UPGRADE'
  | 'LEAD_INQUIRY';

export type Keyword = {
  id: string;
  category: KeywordCategory;
  phrase: string;
  createdAt: string;
};

export type AssignmentStrategy = 'NONE' | 'ROUND_ROBIN' | 'LEAST_OPEN';

export type Team = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isDefault: boolean;
  color: string;
  emoji: string | null;
  /** Automatic assignment for new conversations on this team. */
  assignmentStrategy?: AssignmentStrategy;
  /** Max concurrent open conversations per agent. Null = unlimited. */
  maxConcurrentPerAgent?: number | null;
  _count?: {
    members: number;
    conversations: number;
    sessions: number;
  };
};

export async function fetchTeams(): Promise<Team[]> {
  const { data } = await api.get('/api/system/teams');
  return data;
}

export async function createTeam(input: {
  name: string;
  slug?: string;
  description?: string;
  color?: string;
  emoji?: string;
  isDefault?: boolean;
}): Promise<Team> {
  const { data } = await api.post('/api/system/teams', input);
  return data;
}

export async function updateTeam(id: string, input: Partial<Team>): Promise<Team> {
  const { data } = await api.patch(`/api/system/teams/${id}`, input);
  return data;
}

export async function deleteTeam(id: string): Promise<void> {
  await api.delete(`/api/system/teams/${id}`);
}

export async function fetchKeywords(): Promise<{ categories: KeywordCategory[]; keywords: Keyword[] }> {
  const { data } = await api.get('/api/system/keywords');
  return data;
}

export async function addKeyword(category: KeywordCategory, phrase: string): Promise<Keyword> {
  const { data } = await api.post('/api/system/keywords', { category, phrase });
  return data;
}

export async function deleteKeyword(id: string): Promise<void> {
  await api.delete(`/api/system/keywords/${id}`);
}

// ---------- agent away mode ----------
export async function setAgentAway(away: boolean): Promise<{ isAway: boolean }> {
  const { data } = await api.patch('/api/auth/me/away', { away });
  return data;
}


// ---------------------------------------------------------------------------
// Auto-replies
//
// Every automatic customer-facing message is an organization-owned row. There
// are no platform defaults at send time: if a kind is not configured, or is
// inactive, nothing is sent to the customer.
// ---------------------------------------------------------------------------

export type AutoReplyKind =
  | 'WELCOME'
  | 'OUT_OF_HOURS'
  | 'CSAT_PROMPT'
  | 'CSAT_THANKS'
  | 'CONVERSATION_CLOSED'
  | 'AWAITING_CLIENT'
  | 'KEYWORD_CRITICAL'
  | 'KEYWORD_HIGH'
  | 'KEYWORD_MEDIUM'
  | 'KEYWORD_LOW';

export interface AutoReplySlot {
  kind: AutoReplyKind;
  configured: boolean;
  template: {
    id: string;
    title: string;
    body: string;
    isActive: boolean;
    updatedAt: string;
  } | null;
}

export async function fetchAutoReplies(): Promise<AutoReplySlot[]> {
  const { data } = await api.get('/api/templates/auto-replies');
  return data;
}

export async function saveAutoReply(
  kind: AutoReplyKind,
  input: { title?: string; body?: string; isActive?: boolean },
): Promise<void> {
  await api.put(`/api/templates/auto-replies/${kind}`, input);
}

export async function deleteAutoReply(kind: AutoReplyKind): Promise<void> {
  await api.delete(`/api/templates/auto-replies/${kind}`);
}

/** Plan entitlements as published in the backend's plans.ts. */
export type PlanEntitlements = {
  code: string;
  name: string;
  monthlyPriceCents: number;
  monthlyActiveContactsLimit: number | null;
  monthlyOutboundMessagesLimit: number | null;
  monthlyCampaignSendsLimit: number | null;
  customFieldsLimit: number | null;
  usersLimit: number | null;
  autoProvisionGateway: boolean;
  customDomain: boolean;
  whiteLabel: boolean;
};

export type BillingSummary = {
  plan: { code: string; name: string; monthlyPriceCents: number };
  entitlements: PlanEntitlements;
  subscription: {
    status: string;
    planCode: string;
    currentPeriodEnd: string | null;
    provider: string;
  } | null;
  organization: {
    id: string;
    name: string;
    status: string;
    tier: string;
    downgradeGraceEndsAt: string | null;
    downgradeGraceReason: string | null;
  };
  seats: { used: number; limit: number | null; remaining: number | null; atLimit: boolean };
  usage: CurrentUsage;
  invoices: Array<{
    id: string;
    status: string;
    amountDueCents: number;
    amountPaidCents: number;
    currency: string;
    hostedInvoiceUrl: string | null;
    createdAt: string;
    paidAt: string | null;
  }>;
  plans: Array<{ code: string; name: string; monthlyPriceCents: number }>;
  /**
   * Commercial terms in force. `overrideReason` is deliberately absent — it is
   * the platform owner's internal note and must never reach the customer.
   */
  commercial: {
    isOverridden: boolean;
    source: 'override' | 'subscription' | 'tier';
    expiresAt: string | null;
    discountPercent: number | null;
    listPriceCents: number;
    effectivePriceCents: number;
    creditCents: number;
  };
  /** Non-empty means enforced quotas no longer match the plan of record. */
  quotaDrift: Array<{
    metric: string;
    planAllows: number | null;
    enforced: number | null;
    configured: number | null;
    kind: 'drift' | 'override-written-through';
  }>;
};

export async function fetchBillingSummary(): Promise<BillingSummary> {
  const { data } = await api.get('/api/billing/summary');
  return data;
}

// ---------------------------------------------------------------------------
// Segment filter vocabulary
// ---------------------------------------------------------------------------

export type FilterFieldSpec = {
  field: string;
  type: string;
  values?: string[] | null;
  operators: string[];
};

/**
 * Served by the backend rather than hardcoded here. The backend is the only
 * place that can reject an unknown field, so a client-side copy drifts into
 * offering filters that 400 — and half the vocabulary (custom fields, tags,
 * teams, sent campaigns) is per-organization and unknowable at build time.
 */
export type FilterSchema = {
  maxDepth: number;
  valuelessOperators: string[];
  contactFields: FilterFieldSpec[];
  activityFields: FilterFieldSpec[];
  broadcastFields: FilterFieldSpec[];
  customFields: { slug: string; name: string; dataType: string; allowedValues: string[] }[];
  tags: { name: string }[];
  teams: { id: string; name: string }[];
  campaigns: { id: string; title: string; sentAt: string | null }[];
};

export async function fetchFilterSchema(): Promise<FilterSchema> {
  const { data } = await api.get('/api/contacts/filter-schema');
  return data as FilterSchema;
}

// ---------------------------------------------------------------------------
// Saved segments
// ---------------------------------------------------------------------------

export type Segment = {
  id: string;
  name: string;
  filter: ContactFilterDsl;
  createdById: string;
  createdAt: string;
  updatedAt: string;
};

export async function fetchSegments(): Promise<Segment[]> {
  const { data } = await api.get('/api/segments');
  return data as Segment[];
}

export async function createSegment(input: { name: string; filter: ContactFilterDsl }): Promise<Segment> {
  const { data } = await api.post('/api/segments', input);
  return data as Segment;
}

export async function renameSegment(id: string, name: string): Promise<Segment> {
  const { data } = await api.patch(`/api/segments/${id}`, { name });
  return data as Segment;
}

export async function deleteSegment(id: string): Promise<void> {
  await api.delete(`/api/segments/${id}`);
}

/**
 * A saved view — a named conversation filter pinned to the inbox.
 *
 * Not a segment. Segments filter *contacts* through a nested DSL and feed
 * campaign audiences; a view filters *threads* through the flat grammar below
 * and feeds column 1. One grammar over both would mean every rule carrying
 * "does this apply to people, threads, or both".
 */
export type InboxViewFilter = {
  /** Any-of. Absent means every status. */
  status?: Array<'OPEN' | 'PENDING' | 'RESOLVED' | 'AWAITING_CLIENT'>;
  /**
   * `'me'` is resolved against the viewer, not frozen when the view was saved,
   * so one shared "my open threads" means the right thing to each member.
   */
  assignee?: 'me' | 'unassigned' | { userIds: string[] };
  teamIds?: string[];
  /** The number a thread arrived on, not the gateway that served it. */
  sessionNames?: string[];
  labels?: string[];
  lifecycleStages?: string[];
  /** Nobody has replied yet. */
  unansweredOnly?: boolean;
  /** Snoozed threads stay out of every view unless one asks for them. */
  includeSnoozed?: boolean;
};

export type InboxView = {
  id: string;
  name: string;
  filter: InboxViewFilter;
  sortOrder: number;
  /** Shared with the workspace. Derived from ownership, never stored. */
  shared: boolean;
  ownerId: string | null;
  /**
   * Sent back on edit as a precondition. A mismatch is a 409 rather than an
   * overwrite, so two supervisors editing one shared view cannot silently
   * discard each other's work.
   */
  updatedAt: string;
};

export async function fetchInboxViews(): Promise<InboxView[]> {
  const { data } = await api.get('/api/inbox-views');
  return data as InboxView[];
}

export async function createInboxView(input: {
  name: string;
  filter: InboxViewFilter;
  shared?: boolean;
}): Promise<InboxView> {
  const { data } = await api.post('/api/inbox-views', input);
  return data as InboxView;
}

/**
 * Always send `updatedAt` — it is what turns a concurrent edit into a 409
 * instead of silent data loss. Omitting it tells the server to skip the check.
 */
export async function updateInboxView(
  id: string,
  input: { name?: string; filter?: InboxViewFilter; shared?: boolean; sortOrder?: number; updatedAt: string },
): Promise<InboxView> {
  const { data } = await api.patch(`/api/inbox-views/${id}`, input);
  return data as InboxView;
}

export async function deleteInboxView(id: string): Promise<void> {
  await api.delete(`/api/inbox-views/${id}`);
}

/**
 * Contacts matching a segment — CRM semantics, so opted-out contacts are
 * included. The campaign composer deliberately uses its own audience endpoint,
 * which excludes them, so the same segment shows a smaller number there.
 */
export async function fetchSegmentCount(id: string): Promise<number> {
  const { data } = await api.get(`/api/segments/${id}/count`);
  return (data as { count: number }).count;
}

// ---------------------------------------------------------------------------
// Automations (P11)
// ---------------------------------------------------------------------------

export type WorkflowAction = { type: string; [key: string]: unknown };
export type WorkflowCondition = { type: string; value?: string; field?: string };
export type WorkflowConfig = {
  trigger?: { keyword?: string; tag?: string };
  conditions?: WorkflowCondition[];
  actions: WorkflowAction[];
};

export type Workflow = {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  triggerType: string;
  configJson: WorkflowConfig;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  _count?: { executions: number };
};

export type WorkflowRun = {
  id: string;
  status: string;
  currentStepIndex: number;
  error: string | null;
  executionLog: Array<{ step: number; action: string; outcome: string; detail?: string; at: string }> | null;
  createdAt: string;
};

/**
 * The trigger/condition/action vocabulary, served by the backend.
 *
 * Never hardcoded here: only the server can reject an unknown action, so a
 * client-side copy drifts into offering steps that fail validation on save.
 */
export type WorkflowSchema = {
  triggers: string[];
  conditions: string[];
  actions: string[];
  limits: { maxActions: number; maxConditions: number; maxDelayMinutes: number };
};

export async function fetchWorkflowSchema(): Promise<WorkflowSchema> {
  const { data } = await api.get('/api/workflows/schema');
  return data as WorkflowSchema;
}

export async function fetchWorkflows(): Promise<Workflow[]> {
  const { data } = await api.get('/api/workflows');
  return data as Workflow[];
}

export async function fetchWorkflowRuns(
  id: string,
): Promise<{ runs: WorkflowRun[]; tally: Record<string, number> }> {
  const { data } = await api.get(`/api/workflows/${id}/executions`);
  return data;
}

export async function createWorkflow(input: {
  name: string;
  description?: string | null;
  triggerType: string;
  configJson: WorkflowConfig;
}): Promise<Workflow> {
  const { data } = await api.post('/api/workflows', input);
  return data as Workflow;
}

export async function updateWorkflow(
  id: string,
  input: Partial<{ name: string; description: string | null; isActive: boolean; triggerType: string; configJson: WorkflowConfig }>,
): Promise<Workflow> {
  const { data } = await api.patch(`/api/workflows/${id}`, input);
  return data as Workflow;
}

export async function deleteWorkflow(id: string): Promise<void> {
  await api.delete(`/api/workflows/${id}`);
}

// ---------------------------------------------------------------------------
// Contact import (M8)
// ---------------------------------------------------------------------------

export type ImportRow = {
  phone?: string;
  name?: string;
  email?: string;
  lifecycleStage?: string;
  customFields?: Record<string, string>;
};

export type ImportSummary = {
  total: number;
  created: number;
  updated: number;
  failed: number;
  /** Contacts left OPTED_OUT because an import must not undo a STOP. */
  skippedOptedOut: number;
  errors: Array<{ row: number; reason: string }>;
};

export async function importContacts(input: {
  rows: ImportRow[];
  /** Required. The server refuses the import without it. */
  consentAffirmed: boolean;
  defaultCountryCode?: string;
  tag?: string | null;
}): Promise<ImportSummary> {
  const { data } = await api.post('/api/contacts/import', input);
  return data as ImportSummary;
}

// ---------- reports (M7) ----------

/**
 * Every report takes the same period, and the backend rejects a bad one rather
 * than clamping it — a report that quietly answers a different question than
 * the one asked still looks authoritative on screen.
 */
export type ReportRange = {
  from: string;
  to: string;
  /** Both optional: absent means the whole organization. */
  teamId?: string;
  sessionId?: string;
};

export type Headline = {
  key: string;
  value: number;
  previous: number;
  /** Null when the previous period was zero: that has no rate, only a direction. */
  changePct: number | null;
};

export type DaySeriesPoint = { date: string; inbound: number; outbound: number; resolved: number };

export type OverviewReport = {
  headlines: Headline[];
  /** Null when nothing in the period was answered or resolved. */
  firstResponseMedianMinutes: number | null;
  firstResponsePreviousMinutes: number | null;
  resolutionMedianMinutes: number | null;
  resolutionPreviousMinutes: number | null;
  series: DaySeriesPoint[];
};

export type DurationStats = {
  count: number;
  medianMinutes: number | null;
  meanMinutes: number | null;
  p90Minutes: number | null;
  buckets: { label: string; max: number | null; count: number }[];
  /** The sample was capped, so the summary describes a slice of the period. */
  truncated: boolean;
};

export type HeatmapCell = { dayOfWeek: number; hour: number; inbound: number; outbound: number };

export type ConversationsReport = {
  firstResponse: DurationStats;
  resolution: DurationStats;
  heatmap: HeatmapCell[];
};

export type TeamReportRow = {
  id: string;
  name: string;
  team: { id: string; name: string; color: string | null } | null;
  messagesSent: number;
  conversationsHandled: number;
  resolved: number;
  medianFirstResponseMinutes: number | null;
  csatAvg: number | null;
  csatCount: number;
};

export type CampaignReportRow = {
  id: string;
  title: string;
  sentAt: string | null;
  status: string;
  recipients: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  replied: number;
};

export type GatewayReport = {
  sessions: { id: string; label: string; phoneNumber: string | null; isActive: boolean }[];
  outbound: { total: number; failed: number; failureRatePct: number | null };
  automation: { total: number; automated: number; automatedRatePct: number | null };
};

export type DrilldownMetric = 'started' | 'resolved' | 'answered' | 'unanswered' | 'open';

export type DrilldownRow = {
  id: string;
  displayId: number;
  status: string;
  createdAt: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  contact: { name: string | null; phone: string } | null;
  assignee: { id: string; name: string } | null;
};

export type DrilldownResult = {
  metric: string;
  total: number;
  returned: number;
  conversations: DrilldownRow[];
};

export async function fetchOverviewReport(range: ReportRange): Promise<OverviewReport> {
  const { data } = await api.get('/api/analytics/overview', { params: range });
  return data;
}

export async function fetchConversationsReport(range: ReportRange): Promise<ConversationsReport> {
  const { data } = await api.get('/api/analytics/conversations', {
    params: {
      ...range,
      // The staffing question is about the business's clock, not UTC.
      // `getTimezoneOffset` counts minutes *west*, so it is inverted here.
      utcOffsetMinutes: -new Date().getTimezoneOffset(),
    },
  });
  return data;
}

/**
 * Team and channel now come from the shared range, so the only thing left
 * here is the name search — which is a property of this table, not of the
 * page-wide slice.
 */
export async function fetchTeamReport(
  range: ReportRange,
  filter?: { q?: string },
): Promise<{ agents: TeamReportRow[] }> {
  const { data } = await api.get('/api/analytics/team', { params: { ...range, ...filter } });
  return data;
}

/** Plural: performance across every broadcast in the period. The singular
 *  `fetchCampaignReport` above is the per-recipient report for one campaign. */
export async function fetchCampaignsReport(
  range: ReportRange,
): Promise<{ campaigns: CampaignReportRow[] }> {
  const { data } = await api.get('/api/analytics/campaigns', { params: range });
  return data;
}

export async function fetchGatewayReport(range: ReportRange): Promise<GatewayReport> {
  const { data } = await api.get('/api/analytics/gateway', { params: range });
  return data;
}

export async function fetchDrilldown(
  range: ReportRange,
  metric: DrilldownMetric,
  filter?: { agentId?: string; teamId?: string },
): Promise<DrilldownResult> {
  const { data } = await api.get('/api/analytics/drilldown', {
    params: { ...range, metric, ...filter },
  });
  return data;
}

export type WebhookDirectionHealth = {
  direction: 'INBOUND' | 'OUTBOUND';
  total: number;
  failed: number;
  /** Null when nothing was delivered — silence is not a perfect record. */
  successRatePct: number | null;
  medianLatencyMs: number | null;
  p90LatencyMs: number | null;
  latencySampled: number;
  latencyTruncated: boolean;
};

export type WebhookEndpointRow = {
  webhookId: string;
  targetHost: string | null;
  total: number;
  failed: number;
  successRatePct: number | null;
};

export type WebhookFailureRow = {
  id: string;
  direction: string;
  webhookId: string;
  eventType: string;
  targetHost: string | null;
  statusCode: number | null;
  errorMessage: string | null;
  durationMs: number;
  createdAt: string;
};

export type WebhookReport = {
  directions: WebhookDirectionHealth[];
  endpoints: WebhookEndpointRow[];
  failures: WebhookFailureRow[];
  retentionDays: number;
};

export async function fetchWebhookReport(range: ReportRange): Promise<WebhookReport> {
  const { data } = await api.get('/api/analytics/webhooks', { params: range });
  return data;
}

// ---------- lifecycle stages ----------

/**
 * A stage in the subscriber's own contact pipeline.
 *
 * The list is data, not a constant in this file: a hardcoded vocabulary would
 * be one a subscriber could never rename into their own language.
 */
export type LifecycleStage = {
  id: string;
  name: string;
  color: string | null;
  orderIndex: number;
};

export async function fetchLifecycleStages(): Promise<LifecycleStage[]> {
  const { data } = await api.get('/api/lifecycle-stages');
  return data;
}

export async function createLifecycleStage(input: {
  name: string;
  color?: string | null;
}): Promise<LifecycleStage> {
  const { data } = await api.post('/api/lifecycle-stages', input);
  return data;
}

export async function updateLifecycleStage(
  id: string,
  patch: { name?: string; color?: string | null; orderIndex?: number },
): Promise<LifecycleStage> {
  const { data } = await api.patch(`/api/lifecycle-stages/${id}`, patch);
  return data;
}

/** Returns how many contacts still carry the deleted stage's name. */
export async function deleteLifecycleStage(
  id: string,
): Promise<{ deleted: boolean; affectedContacts: number }> {
  const { data } = await api.delete(`/api/lifecycle-stages/${id}`);
  return data;
}

// ---------- conversation activity (U2) ----------

/**
 * One thing that happened to a conversation, other than a message.
 *
 * `audit` events have a person behind them; `automated` events do not, and the
 * null actor is the signal rather than an omission — "resolved by Kamal" and
 * "closing reply sent" are different kinds of fact.
 */
export type ActivityEvent = {
  id: string;
  kind: 'audit' | 'automated';
  action: string;
  actorName: string | null;
  detail: string | null;
  at: string;
};

export async function fetchConversationActivity(
  convId: string,
): Promise<ActivityEvent[]> {
  const { data } = await api.get(`/api/conversations/${convId}/activity`);
  return data.events ?? [];
}

/** An attachment already sent or received in this conversation. */
export type ConversationFile = {
  id: string;
  url: string;
  mediaType: string | null;
  body: string | null;
  direction: 'in' | 'out';
  time: string;
};

/**
 * Retry one failed outbound message.
 *
 * The server updates the existing row rather than creating a second one, so
 * a retry that turns out to have succeeded the first time cannot double-send.
 * Throws with the server's reason so the caller can show why it failed again.
 */
export async function retryMessage(conversationId: string, messageId: string): Promise<Msg> {
  const { data } = await api.post(
    `/api/conversations/${conversationId}/messages/${messageId}/retry`,
  );
  return {
    id: data.id,
    dir: 'out',
    body: data.body ?? '',
    time: new Date(data.timestamp).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' }),
    auto: !!data.isAuto,
    mediaUrl: data.mediaUrl ?? null,
    mediaType: data.mediaType ?? null,
    status: data.status ?? undefined,
    failureReason: data.failureReason ?? null,
    isInternal: !!data.isInternal,
  };
}

/** How a contact's marketing consent got to its current value. */
export type ConsentProvenance = {
  current: MarketingConsent;
  /** keyword | agent | import | api, or null if never recorded. */
  source: string | null;
  updatedAt: string | null;
  history: Array<{
    id: string;
    fromValue: string | null;
    toValue: string;
    source: string;
    /** Null when a customer's own keyword caused it, and on imports. */
    actorName: string | null;
    at: string;
  }>;
};

export async function fetchConsentProvenance(contactId: string): Promise<ConsentProvenance> {
  const { data } = await api.get(`/api/contacts/${contactId}/consent`);
  return data;
}

/**
 * Conversations where the signed-in user was @mentioned.
 *
 * Ids rather than notifications: the inbox filters its own list by these, and
 * a second list of the same threads rendered differently would be a second
 * thing to keep in sync.
 */
export async function fetchMentionedConversations(): Promise<{
  conversationIds: string[];
  unreadConversationIds: string[];
}> {
  const { data } = await api.get('/api/notifications/mentions');
  return data;
}

/** One of a contact's threads, as the Conversations tab lists them. */
export type ContactConversation = {
  id: string;
  displayId: number;
  status: 'OPEN' | 'PENDING' | 'RESOLVED' | string;
  lastMessageAt: string | null;
  createdAt: string;
  resolvedAt: string | null;
  team: { name: string; color: string | null } | null;
  assignee: { name: string } | null;
  _count: { messages: number };
};

export async function fetchContactConversations(
  contactId: string,
): Promise<ContactConversation[]> {
  const { data } = await api.get(`/api/contacts/${contactId}/conversations`);
  return data;
}

/**
 * One contact's custom field values, keyed by field slug.
 *
 * Read from the contact record rather than carried on every conversation: a
 * list of hundreds of rows has no business hauling every custom field so that
 * one open panel can read one of them.
 */
export async function fetchContactCustomFields(
  contactId: string,
): Promise<Record<string, string | null>> {
  const { data } = await api.get(`/api/contacts/${contactId}`);
  return Object.fromEntries(
    (data.customFieldValues || []).map((row: any) => [row.fieldDefinition.slug, row.value]),
  );
}

/**
 * Is this thread asleep right now?
 *
 * One function so the list filter, the scope count and the header badge
 * cannot disagree. Snooze is a timestamp, not a flag — the moment it passes
 * the conversation is simply awake again, with nothing needing to run.
 */
export function isSnoozed(conv: Conv, now: number = Date.now()): boolean {
  return !!conv.snoozedUntil && new Date(conv.snoozedUntil).getTime() > now;
}

/** Snooze until a moment, or `null` to wake it now. */
export async function snoozeConversation(
  conversationId: string,
  until: Date | null,
): Promise<void> {
  await api.patch(`/api/conversations/${conversationId}/snooze`, {
    until: until ? until.toISOString() : null,
  });
}

/** What a broadcast came back as: who answered, and what they said first. */
export type CampaignReplies = {
  campaign: { id: string; title: string; sentAt: string | null };
  /** False when the campaign never went out — different from nobody replying. */
  sent: boolean;
  total: number;
  returned: number;
  replies: Array<{
    contactId: string;
    name: string | null;
    phone: string;
    conversationId: string;
    displayId: number;
    status: string;
    assigneeName: string | null;
    body: string | null;
    at: string | null;
  }>;
};

export async function fetchCampaignReplies(campaignId: string): Promise<CampaignReplies> {
  const { data } = await api.get(`/api/analytics/campaigns/${campaignId}/replies`);
  return data;
}
