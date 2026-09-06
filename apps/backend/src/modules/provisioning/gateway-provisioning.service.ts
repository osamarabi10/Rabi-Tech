import crypto from 'crypto';
import {
  GatewayProvisioningState,
  GatewayProvisioningStep,
  Prisma,
} from '@prisma/client';
import { encryptCredential, decryptCredential } from '../../lib/credential-crypto';
import { gatewayBackendHost, hostAccessName, webhookBaseUrl } from '../../lib/gateway-host';
import { runAsPlatform } from '../../lib/tenant-context';
import { prisma } from '../../prisma';
import {
  GatewayDeployment,
  GatewayRuntime,
} from './gateway-runtime';
import {
  GatewayProvider,
  isConnectedStatus,
  OpenWAGatewayProvider,
} from './gateway-provider';

export type GatewayAction = 'provision' | 'monitor' | 'suspend' | 'resume' | 'restart' | 'destroy';
export type GatewayProviderFactory = (baseUrl: string, apiKey: string) => GatewayProvider;

const PORT_START = Number(process.env.GATEWAY_PORT_START || 3100);
const PORT_END = Number(process.env.GATEWAY_PORT_END || 3999);

function platformReason(organizationId: string, operation: string): string {
  return `gateway-provisioning:${organizationId}:${operation}`;
}

async function channelFor(organizationId: string) {
  return runAsPlatform(platformReason(organizationId, 'read-channel'), () =>
    prisma.organizationChannel.findUniqueOrThrow({
      where: { organizationId_kind: { organizationId, kind: 'OPENWA' } },
      include: {
        organization: {
          select: {
            id: true,
            slug: true,
            status: true,
            whatsappSessions: { select: { sessionName: true }, orderBy: { createdAt: 'asc' } },
          },
        },
      },
    }),
  );
}

async function persistStep(
  organizationId: string,
  state: GatewayProvisioningState,
  step: GatewayProvisioningStep,
  organizationStatus?: string,
): Promise<void> {
  await runAsPlatform(platformReason(organizationId, `enter-${step.toLowerCase()}`), async () => {
    await prisma.$transaction(async (tx) => {
      await tx.organizationChannel.update({
        where: { organizationId_kind: { organizationId, kind: 'OPENWA' } },
        data: {
          provisioningState: state,
          provisioningStep: step,
          failureReason: null,
          failureStep: null,
          ...(state === 'PROVISIONING' ? { provisioningStartedAt: new Date() } : {}),
          ...(state === 'SUSPENDED' ? { suspendedAt: new Date() } : {}),
        },
      });
      if (organizationStatus) {
        await tx.organization.update({ where: { id: organizationId }, data: { status: organizationStatus } });
      }
    });
  });
}

async function allocateResources(organizationId: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await runAsPlatform(platformReason(organizationId, 'allocate-resources'), async () => {
        await prisma.$transaction(async (tx) => {
          const channel = await tx.organizationChannel.findUniqueOrThrow({
            where: { organizationId_kind: { organizationId, kind: 'OPENWA' } },
            include: { organization: { select: { slug: true } } },
          });
          if (
            channel.apiPort
            && channel.dashboardPort
            && channel.deploymentName
            && channel.dataVolumeName
            && channel.redisVolumeName
            && channel.apiKeyEnc
            && channel.baseUrl
          ) return;

          const allocations = await tx.organizationChannel.findMany({
            where: { OR: [{ apiPort: { not: null } }, { dashboardPort: { not: null } }] },
            select: { apiPort: true, dashboardPort: true },
          });
          const used = new Set<number>();
          for (const allocation of allocations) {
            if (allocation.apiPort) used.add(allocation.apiPort);
            if (allocation.dashboardPort) used.add(allocation.dashboardPort);
          }
          let apiPort: number | undefined;
          for (let candidate = PORT_START; candidate < PORT_END; candidate += 2) {
            if (!used.has(candidate) && !used.has(candidate + 1)) {
              apiPort = candidate;
              break;
            }
          }
          if (!apiPort) throw new Error('No gateway port pair is available');

          const slug = channel.organization.slug;
          const deploymentName = `rabitech-${slug}-gateway`;
          await tx.organizationChannel.update({
            where: { id: channel.id },
            data: {
              managedByProvisioner: true,
              deploymentName,
              apiPort,
              dashboardPort: apiPort + 1,
              dataVolumeName: `rabitech_${slug}_openwa_data`,
              redisVolumeName: `rabitech_${slug}_openwa_redis`,
              // How this platform reaches the tenant gateway: its published
              // host port. lib/gateway-host.ts carries the shared rule.
              baseUrl: `http://${gatewayBackendHost()}:${apiPort}`,
              apiKeyEnc: channel.apiKeyEnc || encryptCredential(crypto.randomBytes(32).toString('base64url')),
              webhookToken: channel.webhookToken || crypto.randomBytes(32).toString('hex'),
            },
          });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      });
      return;
    } catch (error) {
      if (
        attempt < 4
        && error instanceof Prisma.PrismaClientKnownRequestError
        && ['P2002', 'P2034'].includes(error.code)
      ) continue;
      throw error;
    }
  }
}

function deploymentFrom(channel: Awaited<ReturnType<typeof channelFor>>): GatewayDeployment {
  if (
    !channel.deploymentName
    || !channel.apiPort
    || !channel.dashboardPort
    || !channel.dataVolumeName
    || !channel.redisVolumeName
  ) throw new Error('Gateway resource allocation is incomplete');
  return {
    deploymentName: channel.deploymentName,
    organizationSlug: channel.organization.slug,
    apiPort: channel.apiPort,
    dashboardPort: channel.dashboardPort,
    dataVolumeName: channel.dataVolumeName,
    redisVolumeName: channel.redisVolumeName,
    apiKey: decryptCredential(channel.apiKeyEnc),
  };
}

function providerFor(
  channel: Awaited<ReturnType<typeof channelFor>>,
  factory: GatewayProviderFactory,
): GatewayProvider {
  const hostBaseUrl = `http://${hostAccessName()}:${channel.apiPort}`;
  return factory(hostBaseUrl, decryptCredential(channel.apiKeyEnc));
}

async function completeAwaitingQr(organizationId: string): Promise<void> {
  await runAsPlatform(platformReason(organizationId, 'awaiting-qr'), async () => {
    await prisma.$transaction(async (tx) => {
      await tx.organizationChannel.update({
        where: { organizationId_kind: { organizationId, kind: 'OPENWA' } },
        data: {
          status: 'ACTIVE',
          provisioningState: 'AWAITING_QR',
          provisioningStep: 'AWAIT_CONNECTION',
          provisionedAt: new Date(),
          lastCheckedAt: new Date(),
        },
      });
      await tx.organization.update({ where: { id: organizationId }, data: { status: 'PROVISIONING' } });
    });
  });
}

async function markActive(organizationId: string): Promise<void> {
  await runAsPlatform(platformReason(organizationId, 'connected'), async () => {
    await prisma.$transaction(async (tx) => {
      await tx.organizationChannel.update({
        where: { organizationId_kind: { organizationId, kind: 'OPENWA' } },
        data: {
          status: 'ACTIVE',
          provisioningState: 'ACTIVE',
          provisioningStep: 'COMPLETE',
          failureReason: null,
          failureStep: null,
          connectedAt: new Date(),
          lastCheckedAt: new Date(),
          suspendedAt: null,
        },
      });
      await tx.organization.update({ where: { id: organizationId }, data: { status: 'ACTIVE' } });
      await tx.platformAlert.updateMany({
        where: {
          organizationId,
          type: 'GATEWAY_PROVISIONING_FAILED',
          resolvedAt: null,
        },
        data: { resolvedAt: new Date() },
      });
    });
  });
}

async function processProvision(
  organizationId: string,
  runtime: GatewayRuntime,
  providerFactory: GatewayProviderFactory,
): Promise<void> {
  let channel = await channelFor(organizationId);
  if (!channel.managedByProvisioner || !channel.apiPort) {
    await persistStep(organizationId, 'PROVISIONING', 'ALLOCATE_RESOURCES', 'PROVISIONING');
  } else if (channel.provisioningState === 'FAILED') {
    await persistStep(
      organizationId,
      'PROVISIONING',
      channel.failureStep || channel.provisioningStep || 'ALLOCATE_RESOURCES',
      'PROVISIONING',
    );
  }

  for (let guard = 0; guard < 12; guard += 1) {
    channel = await channelFor(organizationId);
    switch (channel.provisioningStep) {
      case 'ALLOCATE_RESOURCES':
        await allocateResources(organizationId);
        await persistStep(organizationId, 'PROVISIONING', 'START_GATEWAY');
        break;
      case 'START_GATEWAY':
        await runtime.createAndStart(deploymentFrom(channel));
        await persistStep(organizationId, 'PROVISIONING', 'WAIT_FOR_PROVIDER');
        break;
      case 'RESUME_GATEWAY':
        await runtime.start(deploymentFrom(channel));
        await persistStep(organizationId, 'PROVISIONING', 'WAIT_FOR_PROVIDER');
        break;
      case 'RESTART_GATEWAY':
        await runtime.restart(deploymentFrom(channel));
        await persistStep(organizationId, 'PROVISIONING', 'WAIT_FOR_PROVIDER');
        break;
      case 'WAIT_FOR_PROVIDER':
        await providerFor(channel, providerFactory).waitUntilReady();
        await persistStep(organizationId, 'PROVISIONING', 'CREATE_SESSION');
        break;
      case 'CREATE_SESSION': {
        const provider = providerFor(channel, providerFactory);
        await provider.ensureSession(channel.organization.whatsappSessions[0]?.sessionName || `${channel.organization.slug}-primary`);
        await persistStep(organizationId, 'PROVISIONING', 'REGISTER_WEBHOOK');
        break;
      }
      case 'REGISTER_WEBHOOK': {
        const provider = providerFor(channel, providerFactory);
        const sessionName = channel.organization.whatsappSessions[0]?.sessionName || `${channel.organization.slug}-primary`;
        const sessionId = await provider.ensureSession(sessionName);
        const webhookBase = webhookBaseUrl();
        await provider.ensureWebhook(sessionId, `${webhookBase}/webhooks/openwa/${channel.webhookToken}`);
        await persistStep(organizationId, 'PROVISIONING', 'AWAIT_CONNECTION');
        break;
      }
      case 'AWAIT_CONNECTION':
        await completeAwaitingQr(organizationId);
        return;
      case 'COMPLETE':
        return;
      default:
        await persistStep(organizationId, 'PROVISIONING', 'ALLOCATE_RESOURCES', 'PROVISIONING');
    }
  }
  throw new Error('Gateway provisioning exceeded its transition guard');
}

async function monitorConnection(
  organizationId: string,
  providerFactory: GatewayProviderFactory,
): Promise<boolean> {
  const channel = await channelFor(organizationId);
  if (!['AWAITING_QR', 'ACTIVE'].includes(channel.provisioningState)) return false;
  const sessionName = channel.organization.whatsappSessions[0]?.sessionName;
  if (!sessionName) throw new Error('Organization has no WhatsApp session');
  const status = await providerFor(channel, providerFactory).sessionStatus(sessionName);
  if (isConnectedStatus(status)) {
    if (channel.provisioningState !== 'ACTIVE') await markActive(organizationId);
    return true;
  }
  await runAsPlatform(platformReason(organizationId, 'connection-check'), () =>
    prisma.organizationChannel.update({
      where: { id: channel.id },
      data: { lastCheckedAt: new Date() },
    }),
  );
  return false;
}

async function suspendGateway(organizationId: string, runtime: GatewayRuntime): Promise<void> {
  await persistStep(organizationId, 'SUSPENDED', 'SUSPEND_GATEWAY', 'SUSPENDED');
  const channel = await channelFor(organizationId);
  if (channel.deploymentName) await runtime.stop(deploymentFrom(channel));
  await persistStep(organizationId, 'SUSPENDED', 'COMPLETE', 'SUSPENDED');
}

async function destroyGateway(organizationId: string, runtime: GatewayRuntime): Promise<void> {
  await persistStep(organizationId, 'PROVISIONING', 'DESTROY_GATEWAY', 'SUSPENDED');
  const channel = await channelFor(organizationId);
  if (channel.deploymentName) await runtime.destroy(deploymentFrom(channel));
  await runAsPlatform(platformReason(organizationId, 'delete-organization'), async () => {
    const identities = await prisma.user.findMany({
      where: { organizationId },
      select: { identityId: true },
    });
    await prisma.organization.delete({ where: { id: organizationId } });
    if (identities.length) {
      await prisma.identity.deleteMany({
        where: {
          id: { in: identities.map((identity) => identity.identityId) },
          users: { none: {} },
          platformRole: 'NONE',
        },
      });
    }
  });
}

export async function processGatewayAction(
  organizationId: string,
  action: GatewayAction,
  runtime: GatewayRuntime,
  providerFactory: GatewayProviderFactory = (baseUrl, apiKey) => new OpenWAGatewayProvider(baseUrl, apiKey),
): Promise<{ connected?: boolean }> {
  switch (action) {
    case 'provision':
      await processProvision(organizationId, runtime, providerFactory);
      return {};
    case 'monitor':
      return { connected: await monitorConnection(organizationId, providerFactory) };
    case 'suspend':
      await suspendGateway(organizationId, runtime);
      return {};
    case 'resume':
      await persistStep(organizationId, 'PROVISIONING', 'RESUME_GATEWAY', 'PROVISIONING');
      await processProvision(organizationId, runtime, providerFactory);
      return {};
    case 'restart':
      await persistStep(organizationId, 'PROVISIONING', 'RESTART_GATEWAY', 'PROVISIONING');
      await processProvision(organizationId, runtime, providerFactory);
      return {};
    case 'destroy':
      await destroyGateway(organizationId, runtime);
      return {};
  }
}

export async function markGatewayFailed(
  organizationId: string,
  reason: string,
): Promise<void> {
  const safeReason = reason.slice(0, 1000);
  await runAsPlatform(platformReason(organizationId, 'terminal-failure'), async () => {
    await prisma.$transaction(async (tx) => {
      const channel = await tx.organizationChannel.findUnique({
        where: { organizationId_kind: { organizationId, kind: 'OPENWA' } },
        select: { provisioningStep: true },
      });
      if (!channel) return;
      await tx.organizationChannel.update({
        where: { organizationId_kind: { organizationId, kind: 'OPENWA' } },
        data: {
          provisioningState: 'FAILED',
          failureStep: channel.provisioningStep,
          failureReason: safeReason,
        },
      });
      await tx.platformAlert.create({
        data: {
          organizationId,
          type: 'GATEWAY_PROVISIONING_FAILED',
          message: safeReason,
          metadata: channel.provisioningStep ? { step: channel.provisioningStep } : undefined,
        },
      });
    });
  });
}
