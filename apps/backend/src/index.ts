import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import { initSocket } from './socket';
import { startCampaignWorker } from './workers/campaign.worker';
import { startCampaignSchedulerWorker } from './workers/campaign-scheduler.worker';
import { startIncomingMessageWorker } from './workers/incoming-message.worker';
import { startEscalationWorker } from './workers/escalation.worker';
import { startUsageRollupWorker } from './workers/usage-rollup.worker';
import logger from './lib/logger';
import { requestLoggingMiddleware } from './middleware/logging.middleware';

// Routes
import authRoutes         from './modules/auth/auth.routes';
import conversationRoutes from './modules/conversations/conversations.routes';
import contactRoutes      from './modules/contacts/contacts.routes';
import segmentRoutes      from './modules/segments/segments.routes';
import lifecycleRoutes from './modules/lifecycle/lifecycle.routes';
import workflowRoutes     from './modules/workflows/workflows.routes';
import campaignRoutes     from './modules/campaigns/campaigns.routes';
import systemRoutes       from './modules/system/system.routes';
import templateRoutes     from './modules/templates/templates.routes';
import analyticsRoutes    from './modules/analytics/analytics.routes';
import notificationRoutes from './modules/notifications/notifications.routes';
import webhookRouter      from './webhooks/openwa.webhook';
import { corsOriginCallback } from './utils/cors';
import { getLanAddresses } from './utils/network';
import { verifyPlatformToken, verifyToken } from './modules/auth/auth.middleware';
import platformRoutes     from './modules/platform/platform.routes';
import usageRoutes        from './modules/usage/usage.routes';
import brandingRoutes     from './modules/branding/branding.routes';
import billingRoutes      from './modules/billing/billing.routes';
import { billingWebhookHandler } from './modules/billing/billing.webhook';
import { verifyMediaProxyToken, verifyMediaToken } from './utils/signed-url';
import { runAsOrganization, runAsPlatform } from './lib/tenant-context';
import { assertKnownPaymentProvider } from './modules/billing/provider-registry';
import { ensurePlans } from './modules/billing/billing.service';
import { startBillingReconciliationWorker } from './workers/billing-reconciliation.worker';
import { scheduleGatewayHealthChecks, startGatewayHealthWorker } from './workers/gateway-health.worker';
import { scheduleAnalyticsRollup, startAnalyticsRollupWorker } from './workers/analytics-rollup.worker';
import { startWorkflowWorker } from './workers/workflow.worker';
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
app.post('/api/billing/webhook', express.raw({ type: '*/*', limit: '1mb' }), billingWebhookHandler);
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

function detectMimeType(buf: Buffer, mediaType?: string): string {
  const sig = buf.slice(0, 8).toString('hex');
  // OGG / Opus — WhatsApp voice notes (ptt)
  if (sig.startsWith('4f676753')) return 'audio/ogg; codecs=opus';
  // MP3
  if (buf.slice(0, 3).toString('ascii') === 'ID3' || sig.startsWith('fffb') || sig.startsWith('fff3')) return 'audio/mpeg';
  // JPEG
  if (sig.startsWith('ffd8ff')) return 'image/jpeg';
  // PNG
  if (sig.startsWith('89504e47')) return 'image/png';
  // GIF
  if (sig.startsWith('47494638')) return 'image/gif';
  // WebP (RIFF....WEBP)
  if (sig.startsWith('52494646') && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  // MP4
  if (sig.slice(8, 16) === '66747970') return 'video/mp4';
  // WebM
  if (sig.startsWith('1a45dfa3')) return 'video/webm';
  // PDF
  if (buf.slice(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  // Fallback to mediaType hint if available
  const hint: Record<string, string> = {
    ptt: 'audio/ogg; codecs=opus', audio: 'audio/mpeg',
    image: 'image/jpeg', video: 'video/mp4',
    document: 'application/octet-stream', sticker: 'image/webp',
  };
  return hint[mediaType || ''] || 'application/octet-stream';
}

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
app.use('/api/auth/signup', LIMITS.signup);
app.use('/api/billing/signup', LIMITS.signup);
app.use('/api/auth/verify-email', LIMITS.emailVerify);
app.use('/api/auth/resend-verification', LIMITS.emailVerify);
app.use('/api/branding/public', LIMITS.publicBranding);
app.use('/webhooks', LIMITS.webhook);
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

  if (
    req.path === '/billing/plans'
    || req.path === '/billing/signup'
    || req.path === '/billing/verify-email'
    || req.path.startsWith('/billing/checkout-status/')
  ) {
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
      next();
    }).catch((err) => {
      res.status(500).json({ error: 'Failed to establish tenant context' });
    });
  });
});

// API Routes
app.use('/api/auth',          authRoutes);
app.use('/api/conversations',  conversationRoutes);
app.use('/api/contacts',       contactRoutes);
app.use('/api/segments',       segmentRoutes);
app.use('/api/lifecycle-stages', lifecycleRoutes);
app.use('/api/workflows',      workflowRoutes);
app.use('/api/campaigns',      campaignRoutes);
app.use('/api/system',         systemRoutes);
app.use('/api/templates',      templateRoutes);
app.use('/api/analytics',      analyticsRoutes);
app.use('/api/notifications',  notificationRoutes);
app.use('/api/platform',       platformRoutes);
app.use('/api/usage',          usageRoutes);
app.use('/api/branding',       brandingRoutes);
app.use('/api/billing',        billingRoutes);

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

httpServer.listen(Number(PORT), HOST, () => {
  ensurePlans().catch((error) => logger.error('Failed to ensure billing plans', { error: String(error) }));
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

  if (process.env.DISABLE_WORKFLOW_WORKER === '1') {
    logger.info('Workflow worker disabled (DISABLE_WORKFLOW_WORKER=1)');
  } else {
    startWorkflowWorker();
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
});
