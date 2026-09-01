import 'dotenv/config';
import express from 'express';
import metaTemplateRoutes from './modules/meta-templates/meta-templates.routes';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import { initSocket } from './socket';
import { startCampaignWorker } from './workers/campaign.worker';
import { startCampaignSchedulerWorker } from './workers/campaign-scheduler.worker';
import { startIncomingMessageWorker } from './workers/incoming-message.worker';
import { startEscalationWorker } from './workers/escalation.worker';
import { startWebhookDeliveryWorker } from './workers/webhook-delivery.worker';
import { startUsageRollupWorker } from './workers/usage-rollup.worker';
import logger from './lib/logger';
import { detectMimeType } from './utils/mime';
import { requestLoggingMiddleware } from './middleware/logging.middleware';

// Routes
import authRoutes         from './modules/auth/auth.routes';
import conversationRoutes from './modules/conversations/conversations.routes';
import conversationSettingsRoutes from './modules/conversations/conversation-settings.routes';
import contactRoutes      from './modules/contacts/contacts.routes';
import segmentRoutes      from './modules/segments/segments.routes';
import { enforceAccess } from './middleware/access-gate.middleware';
import { startMailOutboxWorker } from './workers/mail-outbox.worker';
import { startBackupWorker } from './workers/backup.worker';
import inboxViewRoutes   from './modules/inbox-views/inbox-views.routes';
import lifecycleRoutes from './modules/lifecycle/lifecycle.routes';
import workflowRoutes     from './modules/workflows/workflows.routes';
import campaignRoutes     from './modules/campaigns/campaigns.routes';
import systemRoutes       from './modules/system/system.routes';
import templateRoutes     from './modules/templates/templates.routes';
import snippetRoutes      from './modules/snippets/snippets.routes';
import analyticsRoutes    from './modules/analytics/analytics.routes';
import notificationRoutes from './modules/notifications/notifications.routes';
import webhookRouter      from './webhooks/openwa.webhook';
import { metaWebhookHandler, metaWebhookVerifyHandler } from './webhooks/meta.webhook';
import { corsOriginCallback } from './utils/cors';
import { getLanAddresses } from './utils/network';
import { verifyPlatformToken, verifyToken } from './modules/auth/auth.middleware';
import platformRoutes     from './modules/platform/platform.routes';
import usageRoutes        from './modules/usage/usage.routes';
import brandingRoutes     from './modules/branding/branding.routes';
import billingRoutes      from './modules/billing/billing.routes';
import channelRoutes      from './modules/channels/channels.routes';
import apiTokenRoutes     from './modules/api-tokens/api-tokens.routes';
import publicApiRoutes    from './modules/public-api/index.routes';
import webhookEndpointRoutes from './modules/webhooks/webhooks.routes';
import { billingWebhookHandler } from './modules/billing/billing.webhook';
import { verifyMediaProxyToken, verifyMediaToken } from './utils/signed-url';
import { runAsOrganization, runAsPlatform } from './lib/tenant-context';
import { assertKnownPaymentProvider } from './modules/billing/provider-registry';
import { ensurePlans } from './modules/billing/billing.service';
import { loadEditionCatalogueOrThrow, startEditionRefresh } from './modules/billing/editions.service';
import { startBillingReconciliationWorker } from './workers/billing-reconciliation.worker';
import { scheduleGatewayHealthChecks, startGatewayHealthWorker } from './workers/gateway-health.worker';
import { scheduleAnalyticsRollup, startAnalyticsRollupWorker } from './workers/analytics-rollup.worker';
import { scheduleMetaTemplateSync, startMetaTemplateSyncWorker } from './workers/meta-template-sync.worker';
import { startWorkflowWorker } from './workers/workflow.worker';
import { startWeeklyRecapWorker } from './workers/weekly-recap.worker';
import {
  recoverConversationAutoCloseJobs,
  startAutoCloseWorker,
} from './workers/auto-close.worker';
import { LIMITS } from './middleware/rate-limit.middleware';
import { verifySecrets } from './lib/verify-secrets';

// Fail fast on weak or missing secrets before anything binds a port.
verifySecrets();

const app = express();
const httpServer = http.createServer(app);

// Rate limiting keys on client IP. Behind a reverse proxy every request carries
// the proxy's address unless this is set, which would collapse all clients into
// a single bucket and make the limits useless.
app.set('trust proxy', process.env.TRUST_PROXY ?? 1);

// Middleware
if (process.env.NODE_ENV === 'production') {
  app.use(helmet());
} else {
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginOpenerPolicy: false,
    })
  );
}
app.use(cors({ origin: corsOriginCallback, credentials: true }));
// LIMITS.webhook ahead of express.raw, matching the Meta webhook below. The
// limiter reads only req.ip and never touches the body, so it cannot disturb
// the exact bytes HMAC verification needs — and running it first means a flood
// is rejected before a 1 MB body is buffered and a signature computed over it.
//
// This route is registered here, above `app.use('/api', LIMITS.api)`, which is
// why it had no limiter at all: the general /api backstop never reached it.
// Signature verification is cheap per request and unbounded in aggregate, which
// is the shape of a CPU-burn target even though the endpoint is authenticated.
app.post('/api/billing/webhook', LIMITS.webhook, express.raw({ type: '*/*', limit: '1mb' }), billingWebhookHandler);
// Meta Cloud API webhooks are registered HERE, ahead of express.json, because
// the X-Hub-Signature-256 check must run over the exact bytes Meta signed. A
// parsed-then-reserialised body is a different string, so verifying against it
// rejects legitimate requests and can accept ones Meta never signed.
//
// Mounted before the parser also means the /webhooks rate limiter registered
// further down never sees these requests, so the limit is applied explicitly.
app.get('/webhooks/meta', LIMITS.webhook, metaWebhookVerifyHandler);
app.post('/webhooks/meta', LIMITS.webhook, express.raw({ type: '*/*', limit: '1mb' }), metaWebhookHandler);
// WhatsApp webhooks may include large base64 media payloads
app.use(express.json({ limit: '50mb' }));
// Request logging and correlation IDs
app.use(requestLoggingMiddleware);

// Health check — detailed service status
app.get('/health', async (_, res) => {
  const checks: Record<string, 'ok' | 'error' | 'warning'> = {};
  let statusCode = 200;

  try {
    // Database check
    try {
      await runAsPlatform('healthcheck-database', () =>
        require('./prisma').prisma.user.findFirst({ take: 1 })
      );
      checks.database = 'ok';
    } catch (err) {
      checks.database = 'error';
      statusCode = 503;
      logger.warn('Health check: DB unavailable');
    }

    // Redis check (BullMQ queue) — optional for campaigns/messaging
    try {
      const { campaignQueue } = require('./workers/campaign.worker');
      const redisClient = await campaignQueue.client;
      if (redisClient) {
        await redisClient.ping();
        checks.redis = 'ok';
      } else {
        checks.redis = 'warning';
      }
    } catch (err) {
      checks.redis = 'warning';
      logger.warn('Health check: Redis unavailable (non-critical)');
    }

    // OpenWA session status — warning if no sessions but not critical
    try {
      const activeChannels = await runAsPlatform('healthcheck-openwa', () =>
        require('./prisma').prisma.organizationChannel.count({ where: { status: 'ACTIVE' } })
      );
      checks.openwa = activeChannels > 0 ? 'ok' : 'warning';
    } catch (err) {
      checks.openwa = 'warning';
    }

    // Queue depth
    try {
      const { incomingMessageQueue } = require('./workers/incoming-message.worker');
      const count = await incomingMessageQueue.count();
      checks.queue_depth = count > 100 ? 'warning' : 'ok';
      if (count > 100) statusCode = Math.min(statusCode, 503); // Warn but don't fail
    } catch (err) {
      checks.queue = 'error';
    }
  } catch (err) {
    logger.error('Health check error', { error: String(err) });
  }

  res.status(statusCode).json({
    status: statusCode === 200 ? 'healthy' : 'degraded',
    service: 'RabiTech Backend',
    timestamp: new Date().toISOString(),
    checks,
    uptime: process.uptime(),
  });
});

// LAN access info — requires auth
app.get('/api/network', verifyToken, (req, res) => {
  // This endpoint leaks LAN topology — require authentication
  const frontendPort = process.env.FRONTEND_PORT || '8080';
  const backendPort = String(process.env.PORT || 4000);
  const ips = getLanAddresses();
  res.json({
    ips,
    frontendPort,
    backendPort,
    urls: ips.map((ip) => `http://${ip}:${frontendPort}`),
  });
});


async function verifyBearerTokenForRoute(req: express.Request, res: express.Response): Promise<boolean | null> {
  if (!req.headers.authorization?.startsWith('Bearer ')) return false;
  let authenticated = false;
  await verifyToken(req, res, () => {
    authenticated = true;
  });
  return authenticated ? true : null;
}

// Stream WhatsApp media (images/audio/video/files) from OpenWA so the dashboard
// can load it from any device on the LAN, not just the machine running OpenWA.
// Requires authentication via Bearer token OR valid signed URL token.
app.get('/media-proxy', async (req, res) => {
  const url = req.query.url as string | undefined;
  const mediaType = req.query.type as string | undefined;
  const token = req.query.token as string | undefined;

  const signedUrl = token ? verifyMediaProxyToken(token) : null;
  const bearerAuth = signedUrl ? false : await verifyBearerTokenForRoute(req, res);
  if (!signedUrl && bearerAuth === false) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (bearerAuth === null) return;

  if (!url) return res.status(400).json({ error: 'Missing url' });

  // If using signed token, verify the URL matches the token
  if (signedUrl) {
    if (signedUrl.url !== url) {
      return res.status(401).json({ error: 'Token/URL mismatch' });
    }
  }

  // Accept any URL that looks like an OpenWA media URL (internal hostname may differ from OPENWA_URL)
  const allowedHosts = ['localhost', '127.0.0.1', 'openwa', 'waha'];
  let parsedHost: string;
  try { parsedHost = new URL(url).hostname; } catch { return res.status(400).json({ error: 'Invalid url' }); }
  if (!allowedHosts.some((h) => parsedHost === h || parsedHost.endsWith(`.${h}`))) {
    return res.status(400).json({ error: 'Disallowed media host' });
  }

  try {
    /*
     * The organization comes from whichever proof of identity was given.
     *
     * Demanding `req.user` here made the signed path unreachable: it is set
     * by bearer auth, which a signed request deliberately skips. A correctly
     * signed token was answered with "Organization token required", so the
     * whole mechanism was dead code.
     */
    const organizationId = signedUrl?.organizationId ?? req.user?.organizationId;
    if (!organizationId) return res.status(401).json({ error: 'Organization token required' });
    const { OpenWAService } = require('./modules/whatsapp/openwa.service');
    const upstream = await runAsOrganization(organizationId, () =>
      OpenWAService.getMediaUrl(url),
    );
    const buf = upstream.buffer;
    const upstreamType = upstream.contentType;
    // Prefer detected type over upstream header (OpenWA sometimes returns wrong MIME for voice)
    const contentType = (upstreamType && upstreamType !== 'application/octet-stream')
      ? upstreamType
      : detectMimeType(buf, mediaType);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch {
    res.status(502).json({ error: 'Failed to fetch media' });
  }
});

// Fetch media for a specific WhatsApp message by session + message ID (lazy proxy)
// Requires authentication via Bearer token OR valid signed URL token.
app.get('/media-proxy/message', async (req, res) => {
  const { session, msgId, type, token } = req.query as { session?: string; msgId?: string; type?: string; token?: string };

  const signedMedia = token ? verifyMediaToken(token) : null;
  const bearerAuth = signedMedia ? false : await verifyBearerTokenForRoute(req, res);
  if (!signedMedia && bearerAuth === false) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (bearerAuth === null) return;

  if (!session || !msgId) return res.status(400).json({ error: 'session and msgId required' });

  // If using signed token, verify msgId and session match
  if (signedMedia) {
    if (signedMedia.msgId !== msgId || signedMedia.session !== session) {
      return res.status(401).json({ error: 'Token/params mismatch' });
    }
  }

  try {
    const { OpenWAService } = require('./modules/whatsapp/openwa.service');
    // Signed or bearer — either proves which organization is asking. See the
    // note on the other proxy for why requiring `req.user` broke this.
    const organizationId = signedMedia?.organizationId ?? req.user?.organizationId;
    if (!organizationId) return res.status(401).json({ error: 'Organization token required' });
    const buffer = await runAsOrganization(organizationId, async () => {
      // Still checked: a token proves who is asking, and this proves the
      // message is theirs. A signature over someone else's message id must
      // not become a way to read it.
      const ownedMessage = await require('./prisma').prisma.message.findUnique({
        where: {
          organizationId_waMessageId: {
            organizationId,
            waMessageId: msgId,
          },
        },
        select: { id: true },
      });
      if (!ownedMessage) return 'not-yours' as const;
      const media = await OpenWAService.getMessageMedia(session, msgId);
      return media || ('no-media' as const);
    });

    /*
     * Two different failures, told apart.
     *
     * Both used to be 404 "Media not found": a message belonging to another
     * organization, and the gateway having nothing to give because the session
     * is offline. The first is a permission answer and the second is an
     * outage, and an agent sent to look for a deleted image when their channel
     * is simply down is being sent the wrong way.
     */
    if (buffer === 'not-yours') return res.status(404).json({ error: 'Media not found' });
    if (buffer === 'no-media') {
      return res.status(502).json({
        error: 'تعذّر جلب الصورة من القناة — تأكد إنها متصلة',
        code: 'channel-unavailable',
      });
    }
    const contentType = detectMimeType(buffer, type);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  } catch {
    res.status(502).json({ error: 'Failed to fetch message media' });
  }
});

// Webhook (no auth)
app.use('/', webhookRouter);

// SECURITY: rate limits run before auth so a flood of bad credentials is rejected
// cheaply rather than costing a bcrypt compare each time.
app.use('/api/auth/login', LIMITS.login);
app.use('/api/auth/2fa/login', LIMITS.twoFactorLogin);
app.use('/api/auth/me/2fa', LIMITS.twoFactorManagement);
app.use('/api/auth/signup', LIMITS.signup);
app.use('/api/billing/signup', LIMITS.signup);
app.use('/api/auth/verify-email', LIMITS.emailVerify);
app.use('/api/auth/resend-verification', LIMITS.emailVerify);
app.use('/api/branding/public', LIMITS.publicBranding);
app.use('/webhooks', LIMITS.webhook);
// Before the /api backstop, so a public-API request is bounded by its token
// budget first and only then by the shared per-IP one.
app.use('/api/v1', LIMITS.publicApi, LIMITS.publicApiTotal);
app.use('/api', LIMITS.api);

// SECURITY: Require authentication for ALL /api/* routes except /api/auth/*
// This middleware runs before route handlers and verifies JWT
// For organization-scoped routes, it establishes tenant context via AsyncLocalStorage
app.use('/api', (req, res, next) => {
  // Allow unauthenticated access to /api/auth (login, signup, etc.)
  if (req.path.startsWith('/auth')) {
    return next();
  }

  if (req.path === '/branding/public' || req.path.startsWith('/branding/assets/')) {
    return next();
  }

  // OpenWA downloads workspace Snippet files server-to-server. The HMAC in
  // the URL is the authorization; requiring a browser JWT would make every
  // attachment fail at the gateway.
  if (req.path.startsWith('/snippets/assets/')) {
    return next();
  }

  if (
    req.path === '/billing/plans'
    || req.path === '/billing/signup'
    || req.path === '/billing/verify-email'
    || req.path.startsWith('/billing/checkout-status/')
  ) {
    return next();
  }

  /*
    The public API authenticates with a bearer token, not a session JWT, and
    establishes its own tenant scope in `apiTokenAuth`. Falling through to
    `verifyToken` here would reject every API token as a malformed JWT.

    This is an exemption from *this* middleware only — `/api/v1` is not
    unauthenticated. Its router calls `apiTokenAuth` before any handler, and
    that middleware ends in `runAsOrganization` exactly like the branch below.
  */
  if (req.path === '/v1' || req.path.startsWith('/v1/')) {
    return next();
  }

  if (req.path.startsWith('/platform')) {
    return verifyPlatformToken(req, res, () => {
      runAsPlatform(`platform-api:${req.method}:${req.path}`, () => next()).catch(() => {
        res.status(500).json({ error: 'Failed to establish platform context' });
      });
    });
  }

  if (req.path.startsWith('/branding/organizations')) {
    return verifyPlatformToken(req, res, () => {
      runAsPlatform(`platform-api:${req.method}:${req.path}`, () => next()).catch(() => {
        res.status(500).json({ error: 'Failed to establish platform context' });
      });
    });
  }

  // All other /api routes require authentication + tenant context setup
  verifyToken(req, res, () => {
    // At this point, req.user is set and includes organizationId
    if (!req.user?.organizationId) {
      return res.status(401).json({ error: 'Invalid token: missing organizationId' });
    }

    // Wrap all downstream handlers in organization tenant context
    // This ensures all Prisma queries are auto-scoped to this organization
    runAsOrganization(req.user.organizationId, () => {
      // Authenticated, and scoped to a tenant — now: is that tenant allowed
      // to be here at all? Expired trial, or a suspension that until now was
      // a status nothing enforced. Inside the tenant context so anything it
      // reads is scoped like everything else.
      enforceAccess(req, res, next);
    }).catch((err) => {
      res.status(500).json({ error: 'Failed to establish tenant context' });
    });
  });
});

// API Routes
app.use('/api/auth',          authRoutes);
app.use('/api/conversations',  conversationRoutes);
app.use('/api/conversation-settings', conversationSettingsRoutes);
app.use('/api/contacts',       contactRoutes);
app.use('/api/segments',       segmentRoutes);
app.use('/api/inbox-views',    inboxViewRoutes);
app.use('/api/lifecycle-stages', lifecycleRoutes);
app.use('/api/workflows',      workflowRoutes);
app.use('/api/campaigns',      campaignRoutes);
app.use('/api/meta-templates', metaTemplateRoutes);
app.use('/api/system',         systemRoutes);
app.use('/api/templates',      templateRoutes);
app.use('/api/snippets',       snippetRoutes);
app.use('/api/analytics',      analyticsRoutes);
app.use('/api/notifications',  notificationRoutes);
app.use('/api/platform',       platformRoutes);
app.use('/api/usage',          usageRoutes);
app.use('/api/branding',       brandingRoutes);
app.use('/api/billing',        billingRoutes);
app.use('/api/channels',       channelRoutes);
app.use('/api/api-tokens',     apiTokenRoutes);
app.use('/api/webhook-endpoints', webhookEndpointRoutes);
// The public API. Mounted last among /api routes and versioned in the path;
// it authenticates itself and shares no handler with the console.
app.use('/api/v1',             publicApiRoutes);

// 404
app.use((req: any, res) => {
  logger.warn('404 Not Found', { path: req.path, method: req.method, requestId: req.id });
  res.status(404).json({ error: 'Not found', requestId: req.id });
});

// Global error handler
app.use((err: any, req: any, res: any, _next: any) => {
  const requestId = req.id;
  const statusCode = err.status || err.statusCode || 500;
  const message = err.message || 'Internal server error';

  logger.error('Request error', {
    requestId,
    statusCode,
    message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  // Don't leak internal error details to client in production
  const isDev = process.env.NODE_ENV !== 'production';
  const errorResponse: any = {
    error: statusCode >= 500 ? 'Internal server error' : message,
    requestId,
  };

  if (isDev) {
    errorResponse.details = message;
    errorResponse.stack = err.stack;
  }

  res.status(statusCode).json(errorResponse);
});

const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || '0.0.0.0';

let isShuttingDown = false;

try {
  assertKnownPaymentProvider();
} catch (error) {
  logger.error('Billing provider configuration is invalid', { error: String(error) });
  process.exit(1);
}

initSocket(httpServer);

// Graceful shutdown
const gracefulShutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal}, shutting down gracefully...`);

  // Stop accepting new connections
  httpServer.close(async () => {
    try {
      logger.info('HTTP server closed');
      // Close database connections
      await require('./prisma').prisma.$disconnect();
      logger.info('Database disconnected');
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown', { error: String(err) });
      process.exit(1);
    }
  });

  // Force shutdown after 30 seconds
  setTimeout(() => {
    logger.error('Forced shutdown timeout exceeded');
    process.exit(1);
  }, 30000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

/**
 * What must be true before the port opens.
 *
 * The edition catalogue used to load inside the listen callback, so the server
 * was already accepting traffic while it loaded and the synchronous accessor
 * covered the gap with the compiled-in constant. The constant is no longer a
 * fallback — reads now fall to a restricted floor — so that gap would mean
 * denying every entitlement check to real customers while reporting healthy to
 * a load balancer.
 *
 * Seed first, then load: ensurePlans writes the rows the catalogue reads.
 */
async function bootGate(): Promise<void> {
  // Each step names itself. Both fail the same way when the database is down,
  // and a log line that blames the catalogue for a seeding failure sends the
  // reader to the wrong place.
  try {
    await ensurePlans();
  } catch (error) {
    throw new Error(
      `Could not seed the plan catalogue: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const editions = await loadEditionCatalogueOrThrow();
  logger.info('Edition catalogue loaded; opening the port', { editions });
}

function onListening(): void {
  // The catalogue is already in memory. This only keeps it warm.
  startEditionRefresh();
  logger.info(`RabiTech Backend running on http://${HOST}:${PORT}`);
  if (process.env.DISABLE_CAMPAIGN_WORKER === '1') {
    logger.info('Campaign worker disabled (DISABLE_CAMPAIGN_WORKER=1)');
  } else {
    startCampaignWorker();
    startCampaignSchedulerWorker();
  }

  if (process.env.DISABLE_MESSAGE_WORKER === '1') {
    logger.info('Incoming message worker disabled (DISABLE_MESSAGE_WORKER=1)');
  } else {
    startIncomingMessageWorker();
  }

  if (process.env.DISABLE_WEBHOOK_WORKER === '1') {
    logger.info('Webhook delivery worker disabled (DISABLE_WEBHOOK_WORKER=1)');
  } else {
    startWebhookDeliveryWorker();
  }

  if (process.env.DISABLE_ESCALATION_WORKER === '1') {
    logger.info('Escalation worker disabled (DISABLE_ESCALATION_WORKER=1)');
  } else {
    startEscalationWorker();
  }

  if (process.env.DISABLE_USAGE_ROLLUP_WORKER === '1') {
    logger.info('Usage rollup worker disabled (DISABLE_USAGE_ROLLUP_WORKER=1)');
  } else {
    startUsageRollupWorker();
  }

  if (process.env.DISABLE_BILLING_RECONCILIATION_WORKER === '1') {
    logger.info('Billing reconciliation worker disabled (DISABLE_BILLING_RECONCILIATION_WORKER=1)');
  } else {
    startBillingReconciliationWorker();
  }

  if (process.env.DISABLE_MAIL_OUTBOX_WORKER === '1') {
    logger.info('Mail outbox worker disabled (DISABLE_MAIL_OUTBOX_WORKER=1)');
  } else {
    startMailOutboxWorker();
  }

  if (process.env.DISABLE_BACKUP_WORKER === '1') {
    logger.info('Backup worker disabled (DISABLE_BACKUP_WORKER=1)');
  } else {
    startBackupWorker();
  }

  if (process.env.DISABLE_WORKFLOW_WORKER === '1') {
    logger.info('Workflow worker disabled (DISABLE_WORKFLOW_WORKER=1)');
  } else {
    startWorkflowWorker();
  }

  if (process.env.DISABLE_WEEKLY_RECAP_WORKER === '1') {
    logger.info('Weekly recap worker disabled (DISABLE_WEEKLY_RECAP_WORKER=1)');
  } else {
    startWeeklyRecapWorker();
  }

  if (process.env.DISABLE_AUTO_CLOSE_WORKER === '1') {
    logger.info('Conversation auto-close worker disabled (DISABLE_AUTO_CLOSE_WORKER=1)');
  } else {
    startAutoCloseWorker();
    recoverConversationAutoCloseJobs().catch((error) =>
      logger.error('Failed to recover conversation auto-close jobs', { error: String(error) }),
    );
  }

  if (process.env.DISABLE_GATEWAY_HEALTH_WORKER === '1') {
    logger.info('Gateway health worker disabled (DISABLE_GATEWAY_HEALTH_WORKER=1)');
  } else {
    startGatewayHealthWorker();
    scheduleGatewayHealthChecks().catch((error) =>
      logger.error('Failed to schedule gateway health checks', { error: String(error) }),
    );
  }

  if (process.env.DISABLE_ANALYTICS_ROLLUP_WORKER === '1') {
    logger.info('Analytics rollup worker disabled (DISABLE_ANALYTICS_ROLLUP_WORKER=1)');
  } else {
    startAnalyticsRollupWorker();
    scheduleAnalyticsRollup().catch((error) =>
      logger.error('Failed to schedule analytics rollup', { error: String(error) }),
    );
  }

  if (process.env.DISABLE_META_TEMPLATE_SYNC_WORKER === '1') {
    logger.info('Meta template sync worker disabled (DISABLE_META_TEMPLATE_SYNC_WORKER=1)');
  } else {
    startMetaTemplateSyncWorker();
    scheduleMetaTemplateSync().catch((error) =>
      logger.error('Failed to schedule Meta template sync', { error: String(error) }),
    );
  }
}

/**
 * Start, or fail loudly.
 *
 * Exit 1 rather than retrying. A container that exits is restarted by its
 * supervisor with the reason in the log; a process that retries silently looks
 * alive while serving nothing, and that is the failure this gate exists to
 * prevent. The database being unreachable is now a hard boot dependency, which
 * it already was in practice — this only makes it say so.
 */
bootGate().then(
  () => httpServer.listen(Number(PORT), HOST, onListening),
  (error: unknown) => {
    logger.error('Backend failed to start; the port was never opened', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  },
);
