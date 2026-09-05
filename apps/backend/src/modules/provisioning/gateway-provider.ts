import axios, { AxiosInstance } from 'axios';

type ProviderSession = { id: string; name: string; status?: string; state?: string };

function sessionsFrom(value: unknown): ProviderSession[] {
  if (Array.isArray(value)) return value as ProviderSession[];
  const wrapped = value as { sessions?: ProviderSession[] } | null;
  return Array.isArray(wrapped?.sessions) ? wrapped.sessions : [];
}

export function isConnectedStatus(value: unknown): boolean {
  return ['connected', 'authenticated', 'working', 'ready'].includes(
    String(value || '').toLowerCase(),
  );
}

export interface GatewayProvider {
  waitUntilReady(): Promise<void>;
  ensureSession(name: string): Promise<string>;
  ensureWebhook(sessionId: string, url: string): Promise<void>;
  sessionStatus(name: string): Promise<string>;
}

export class OpenWAGatewayProvider implements GatewayProvider {
  private readonly client: AxiosInstance;

  constructor(baseUrl: string, apiKey: string) {
    this.client = axios.create({
      baseURL: baseUrl,
      headers: { 'X-API-Key': apiKey },
      timeout: 10_000,
    });
  }

  private async sessions(): Promise<ProviderSession[]> {
    const response = await this.client.get('/api/sessions');
    return sessionsFrom(response.data);
  }

  async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + Number(process.env.GATEWAY_READY_TIMEOUT_MS || 60_000);
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await this.sessions();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    throw new Error(`OpenWA did not become ready: ${String((lastError as Error)?.message || lastError)}`);
  }

  async ensureSession(name: string): Promise<string> {
    let session = (await this.sessions()).find((item) => item.name === name);
    if (!session) {
      const response = await this.client.post('/api/sessions', { name });
      session = response.data as ProviderSession;
      if (!session?.id) {
        session = (await this.sessions()).find((item) => item.name === name);
      }
    }
    if (!session?.id) throw new Error(`OpenWA session ${name} was not created`);

    const status = String(session.status || session.state || '').toLowerCase();
    /*
      This gateway's own vocabulary, read from OpenWA 0.23.2's SessionStatus
      enum: created · initializing · qr_ready · authenticating · ready ·
      disconnected · failed · action_required. A session in `initializing` or
      `qr_ready` is already running — it is waiting for a human to scan — and
      asking it to start again is answered with 400 "Session is already
      started", not 409. The old list knew `starting` and `authenticating`
      only, so a session that had reached the QR was told to start, refused,
      and the provision failed one step short of AWAITING_QR.
    */
    const alreadyRunning = ['starting', 'initializing', 'qr_ready', 'authenticating'];
    if (!isConnectedStatus(status) && !alreadyRunning.includes(status)) {
      await this.client.post(`/api/sessions/${session.id}/start`).catch((error) => {
        // 409 from older builds, 400 "already started" from 0.23.x. Either
        // means the session is up, which is the outcome this call wanted.
        const code = error?.response?.status;
        const message = String(error?.response?.data?.message || '');
        if (code === 409) return;
        if (code === 400 && /already started/i.test(message)) return;
        throw error;
      });
    }
    return session.id;
  }

  async ensureWebhook(sessionId: string, url: string): Promise<void> {
    const response = await this.client.get(`/api/sessions/${sessionId}/webhooks`);
    const webhooks = Array.isArray(response.data) ? response.data : response.data?.webhooks || [];
    if (webhooks.some((webhook: { url?: string }) => webhook.url === url)) return;
    await this.client.post(`/api/sessions/${sessionId}/webhooks`, {
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
  }

  async sessionStatus(name: string): Promise<string> {
    const session = (await this.sessions()).find((item) => item.name === name);
    if (!session) return 'missing';
    const response = await this.client.get(`/api/sessions/${session.id}`);
    return String(response.data?.status || response.data?.state || session.status || session.state || '');
  }
}
