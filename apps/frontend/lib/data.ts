// Data layer — always uses the live backend API.
import api from './api';

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
  labels: string[];
};

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
export type Session = { sessionName: string; label: string; connected: boolean };
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
  return new Date(iso).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
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
    name: data.contact?.name || formatPhone(data.contact?.phone) || 'غير معروف',
    phone: formatPhone(data.contact?.phone),
    status: data.status,
    lastMsg: data.messages?.[0]?.body || '',
    lastTime: fmtTime(data.lastMessageAt),
    sessionDate: fmtDate(data.createdAt),
    unread: data._count?.messages ?? 0,
    avatar: (data.contact?.name || data.contact?.phone || '؟').charAt(0),
    assigneeId: data.assignee?.id ?? null,
    assigneeName: data.assignee?.name ?? null,
    contactId: data.contact?.id ?? '',
    contactTags: data.contact?.tags ?? [],
    contactNotes: data.contact?.notes ?? null,
    marketingConsent: data.contact?.marketingConsent ?? 'UNKNOWN',
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
    name: c.contact?.name || formatPhone(c.contact?.phone) || 'غير معروف',
    phone: formatPhone(c.contact?.phone),
    status: c.status,
    lastMsg: c.messages?.[0]?.body || '',
    lastTime: fmtTime(c.lastMessageAt),
    sessionDate: fmtDate(c.createdAt),
    unread: c._count?.messages ?? 0,
    avatar: (c.contact?.name || c.contact?.phone || '؟').charAt(0),
    assigneeId: c.assignee?.id ?? null,
    assigneeName: c.assignee?.name ?? null,
    contactId: c.contact?.id ?? '',
    contactTags: c.contact?.tags ?? [],
    contactNotes: c.contact?.notes ?? null,
    marketingConsent: c.contact?.marketingConsent ?? 'UNKNOWN',
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

export async function sendReply(convId: string, body: string, isInternal = false): Promise<Msg> {
  const { data } = await api.post(`/api/conversations/${convId}/reply`, { body, isInternal });
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
): Promise<{ count: number; sample: Array<{ id: string; name: string | null; phone: string; firstName: string | null }> }> {
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
  /** Non-empty means enforced quotas no longer match the named plan. */
  quotaDrift: Array<{ metric: string; planAllows: number | null; enforced: number | null }>;
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
