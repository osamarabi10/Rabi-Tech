import axios, { AxiosInstance } from 'axios';
import { decryptCredential } from '../../lib/credential-crypto';
import { getTenantCache, getTenantId } from '../../lib/tenant-context';
import { prisma } from '../../prisma';
import {
  OutboundUsageOptions,
  prepareOutboundSend,
  recordSuccessfulOutboundSend,
} from '../usage/entitlements';

const SESSION_CACHE_TTL_MS = 60_000;

function toChatId(phone: string): string {
  return phone.includes('@') ? phone : `${phone}@c.us`;
}

class OpenWAOrganizationProvider {
  private readonly client: AxiosInstance;
  private readonly sessionIds = new Map<string, { id: string; expiresAt: number }>();

  constructor(baseUrl: string, apiKey: string) {
    this.client = axios.create({
      baseURL: baseUrl,
      headers: { 'X-API-Key': apiKey },
      timeout: 15000,
    });
  }

  private async listSessions(): Promise<Array<{ id: string; name: string }>> {
    const { data } = await this.client.get('/api/sessions');
    const sessions: Array<{ id: string; name: string }> = Array.isArray(data)
      ? data
      : data?.sessions || [];
    const expiresAt = Date.now() + SESSION_CACHE_TTL_MS;
    for (const session of sessions) {
      this.sessionIds.set(session.name, { id: session.id, expiresAt });
    }
    return sessions;
  }

  private async resolveSessionId(name: string): Promise<string> {
    const cached = this.sessionIds.get(name);
    if (cached && cached.expiresAt > Date.now()) return cached.id;
    const sessions = await this.listSessions();
    const id = sessions.find((session) => session.name === name)?.id;
    if (!id) throw new Error(`OpenWA session "${name}" not found for organization`);
    return id;
  }

  async sessionNameById(id: string): Promise<string | undefined> {
    for (const [name, cached] of this.sessionIds) {
      if (cached.id === id && cached.expiresAt > Date.now()) return name;
    }
    try {
      return (await this.listSessions()).find((session) => session.id === id)?.name;
    } catch {
      return undefined;
    }
  }

  async sendText(session: string, to: string, message: string) {
    const id = await this.resolveSessionId(session);
    return this.client.post(`/api/sessions/${id}/messages/send-text`, {
      chatId: toChatId(to),
      text: message,
    });
  }

  async sendMedia(session: string, to: string, url: string, caption?: string) {
    const id = await this.resolveSessionId(session);
    return this.client.post(`/api/sessions/${id}/messages/send-image`, {
      chatId: toChatId(to),
      url,
      caption,
    });
  }

  async getStatus(sessionName: string) {
    return this.client.get(`/api/sessions/${await this.resolveSessionId(sessionName)}`);
  }

  async getQR(sessionName: string) {
    return this.client.get(`/api/sessions/${await this.resolveSessionId(sessionName)}/qr`);
  }

  getSessions() {
    return this.client.get('/api/sessions');
  }

  async createSession(name: string) {
    const response = await this.client.post('/api/sessions', { name });
    if (response.data?.id) {
      this.sessionIds.set(name, {
        id: response.data.id,
        expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
      });
    }
    return response;
  }

  async getContact(session: string, chatId: string) {
    const id = await this.resolveSessionId(session);
    const { data } = await this.client.get(
      `/api/sessions/${id}/contacts/${encodeURIComponent(chatId)}`,
    );
    return data as { id?: string; number?: string; name?: string; pushName?: string };
  }

  async startSession(sessionName: string) {
    return this.client.post(`/api/sessions/${await this.resolveSessionId(sessionName)}/start`);
  }

  async stopSession(sessionName: string) {
    return this.client.post(`/api/sessions/${await this.resolveSessionId(sessionName)}/stop`);
  }

  /**
   * Removes the session from the gateway, discarding its saved WhatsApp
   * credentials. `stop` alone keeps them, so the same number silently
   * reconnects — this is the only way to force a fresh QR for a different phone.
   *
   * Clears the id cache: recreating under the same name yields a new id, and a
   * stale entry would point at a session that no longer exists.
   */
  async deleteSession(sessionName: string) {
    const id = await this.resolveSessionId(sessionName);
    const response = await this.client.delete(`/api/sessions/${id}`);
    this.sessionIds.delete(sessionName);
    return response;
  }

  async getMessageMedia(session: string, messageId: string): Promise<Buffer | null> {
    try {
      const id = await this.resolveSessionId(session);
      const response = await this.client.get(
        `/api/sessions/${id}/messages/${encodeURIComponent(messageId)}/media`,
        { responseType: 'arraybuffer', timeout: 20000 },
      );
      return Buffer.from(response.data);
    } catch {
      return null;
    }
  }

  async getMediaUrl(url: string): Promise<{ buffer: Buffer; contentType?: string }> {
    const response = await this.client.get(url, {
      responseType: 'arraybuffer',
      timeout: 20000,
    });
    return {
      buffer: Buffer.from(response.data),
      contentType: response.headers['content-type'] as string | undefined,
    };
  }

  async ensureWebhook(url: string): Promise<number> {
    const sessions = await this.listSessions();
    let created = 0;
    for (const session of sessions) {
      const { data } = await this.client.get(`/api/sessions/${session.id}/webhooks`);
      const webhooks: Array<{ url?: string }> = Array.isArray(data) ? data : data?.webhooks || [];
      if (webhooks.some((webhook) => webhook.url === url)) continue;
      await this.client.post(`/api/sessions/${session.id}/webhooks`, {
        url,
        events: [
          'message.received',
          'message.sent',
          'message.ack',
          'session.status',
          'session.authenticated',
          'session.disconnected',
        ],
        retryCount: 3,
      });
      created += 1;
    }
    return created;
  }
}

async function provider(allowPairing = false): Promise<OpenWAOrganizationProvider> {
  const organizationId = getTenantId();
  const cache = getTenantCache();
  const cacheKey = `openwa-provider:${organizationId}:${allowPairing ? 'pairing' : 'active'}`;
  const cached = cache.get(cacheKey) as OpenWAOrganizationProvider | undefined;
  if (cached) return cached;

  const channel = await prisma.organizationChannel.findUnique({
    where: { organizationId_kind: { organizationId, kind: 'OPENWA' } },
  });
  const provisioningAllowed = channel && (
    !channel.managedByProvisioner
    || channel.provisioningState === 'ACTIVE'
    || (allowPairing && channel.provisioningState === 'AWAITING_QR')
  );
  if (!channel || channel.status !== 'ACTIVE' || !provisioningAllowed) {
    throw new Error('Active OpenWA channel is not configured for organization');
  }
  const instance = new OpenWAOrganizationProvider(
    channel.baseUrl,
    decryptCredential(channel.apiKeyEnc),
  );
  cache.set(cacheKey, instance);
  return instance;
}

export async function sessionNameById(id: string): Promise<string | undefined> {
  return (await provider(true)).sessionNameById(id);
}

/**
 * WhatsApp id of a message we just sent. Delivery/read acks arrive later keyed
 * by this id, so anything that wants to track its own send has to keep it.
 */
export function responseMessageId(response: { data?: any }): string | null {
  const value = response.data?.id?._serialized
    ?? response.data?.id
    ?? response.data?.messageId
    ?? response.data?.key?.id;
  return typeof value === 'string' ? value : null;
}

async function meteredSend<T extends { data?: any }>(
  address: string,
  options: OutboundUsageOptions,
  send: () => Promise<T>,
): Promise<T> {
  const { contactId } = await prepareOutboundSend(address, options);
  const response = await send();
  await recordSuccessfulOutboundSend(contactId, responseMessageId(response), options);
  return response;
}

export const OpenWAService = {
  sendText: async (
    session: string,
    to: string,
    message: string,
    options: OutboundUsageOptions = {},
  ) => meteredSend(to, options, async () => (await provider()).sendText(session, to, message)),
  sendMedia: async (
    session: string,
    to: string,
    url: string,
    caption?: string,
    options: OutboundUsageOptions = {},
  ) => meteredSend(to, options, async () => (await provider()).sendMedia(session, to, url, caption)),
  getContact: async (...args: Parameters<OpenWAOrganizationProvider['getContact']>) =>
    (await provider()).getContact(...args),
  getMessageMedia: async (...args: Parameters<OpenWAOrganizationProvider['getMessageMedia']>) =>
    (await provider()).getMessageMedia(...args),
  getMediaUrl: async (...args: Parameters<OpenWAOrganizationProvider['getMediaUrl']>) =>
    (await provider()).getMediaUrl(...args),
  getStatus: async (...args: Parameters<OpenWAOrganizationProvider['getStatus']>) =>
    (await provider()).getStatus(...args),
  getSessions: async () => (await provider()).getSessions(),
  createSession: async (...args: Parameters<OpenWAOrganizationProvider['createSession']>) =>
    (await provider()).createSession(...args),
  getQR: async (...args: Parameters<OpenWAOrganizationProvider['getQR']>) =>
    (await provider()).getQR(...args),
  startSession: async (...args: Parameters<OpenWAOrganizationProvider['startSession']>) =>
    (await provider()).startSession(...args),
  stopSession: async (...args: Parameters<OpenWAOrganizationProvider['stopSession']>) =>
    (await provider()).stopSession(...args),
  ensureWebhook: async (...args: Parameters<OpenWAOrganizationProvider['ensureWebhook']>) =>
    (await provider()).ensureWebhook(...args),
};

export const OpenWAPairingProvider = {
  getStatus: async (...args: Parameters<OpenWAOrganizationProvider['getStatus']>) =>
    (await provider(true)).getStatus(...args),
  getSessions: async () => (await provider(true)).getSessions(),
  createSession: async (...args: Parameters<OpenWAOrganizationProvider['createSession']>) =>
    (await provider(true)).createSession(...args),
  getQR: async (...args: Parameters<OpenWAOrganizationProvider['getQR']>) =>
    (await provider(true)).getQR(...args),
  startSession: async (...args: Parameters<OpenWAOrganizationProvider['startSession']>) =>
    (await provider(true)).startSession(...args),
  stopSession: async (...args: Parameters<OpenWAOrganizationProvider['stopSession']>) =>
    (await provider(true)).stopSession(...args),
  deleteSession: async (...args: Parameters<OpenWAOrganizationProvider['deleteSession']>) =>
    (await provider(true)).deleteSession(...args),
};
