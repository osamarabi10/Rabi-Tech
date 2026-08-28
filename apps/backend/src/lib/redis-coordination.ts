import { createHash, randomUUID } from 'crypto';
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  lazyConnect: true,
  maxRetriesPerRequest: null,
});

const ACQUIRE_SCRIPT = `
local queueKey = KEYS[1]
local lockKey = KEYS[2]
local waiterPrefix = ARGV[1]
local token = ARGV[2]
local leaseMs = tonumber(ARGV[3])

while true do
  local head = redis.call('LINDEX', queueKey, 0)
  if not head then return 0 end
  if redis.call('EXISTS', waiterPrefix .. head) == 0 then
    redis.call('LPOP', queueKey)
  else
    break
  end
end

local head = redis.call('LINDEX', queueKey, 0)
if head ~= token then return 0 end

local owner = redis.call('GET', lockKey)
if owner == token then
  redis.call('PEXPIRE', lockKey, leaseMs)
  return 1
end
if not owner and redis.call('SET', lockKey, token, 'PX', leaseMs, 'NX') then
  return 1
end
return 0
`;

const RELEASE_SCRIPT = `
local queueKey = KEYS[1]
local lockKey = KEYS[2]
local waiterKey = KEYS[3]
local token = ARGV[1]

if redis.call('GET', lockKey) == token then redis.call('DEL', lockKey) end
if redis.call('LINDEX', queueKey, 0) == token then
  redis.call('LPOP', queueKey)
else
  redis.call('LREM', queueKey, 1, token)
end
redis.call('DEL', waiterKey)
return 1
`;

const RATE_LIMIT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
if current <= tonumber(ARGV[2]) then return 0 end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 1 then return 1 end
return ttl
`;

export function coordinationKey(namespace: string, ...parts: Array<string | number>): string {
  const digest = createHash('sha256').update(parts.join('\u001f')).digest('hex');
  return `rabitech:coord:${namespace}:${digest}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withFifoRedisLock<T>(
  key: string,
  fn: () => Promise<T>,
  options: { leaseMs?: number; pollMs?: number; waitTimeoutMs?: number } = {},
): Promise<T> {
  const leaseMs = options.leaseMs ?? 30_000;
  const pollMs = options.pollMs ?? 25;
  const waitTimeoutMs = options.waitTimeoutMs ?? 120_000;
  const token = randomUUID();
  const queueKey = `${key}:wait`;
  const lockKey = `${key}:lock`;
  const waiterPrefix = `${key}:waiter:`;
  const waiterKey = `${waiterPrefix}${token}`;
  const heartbeatMs = Math.max(250, Math.floor(leaseMs / 3));
  const startedAt = Date.now();

  await redis.set(waiterKey, '1', 'PX', leaseMs);
  await redis.rpush(queueKey, token);

  const heartbeat = setInterval(() => {
    redis.pexpire(waiterKey, leaseMs).catch(() => undefined);
    redis.eval(ACQUIRE_SCRIPT, 2, queueKey, lockKey, waiterPrefix, token, leaseMs)
      .catch(() => undefined);
  }, heartbeatMs);
  heartbeat.unref();

  try {
    while (true) {
      const acquired = Number(await redis.eval(
        ACQUIRE_SCRIPT,
        2,
        queueKey,
        lockKey,
        waiterPrefix,
        token,
        leaseMs,
      ));
      if (acquired === 1) break;
      if (Date.now() - startedAt >= waitTimeoutMs) {
        throw new Error(`Timed out waiting for serialized work key ${key}`);
      }
      await sleep(pollMs);
    }
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await redis.eval(RELEASE_SCRIPT, 3, queueKey, lockKey, waiterKey, token).catch(() => undefined);
  }
}

export async function waitForRedisRateLimit(
  key: string,
  max: number,
  durationMs: number,
): Promise<void> {
  const safeMax = Math.max(1, Math.floor(max));
  const safeDuration = Math.max(1, Math.floor(durationMs));
  while (true) {
    const waitMs = Number(await redis.eval(
      RATE_LIMIT_SCRIPT,
      1,
      `${key}:rate`,
      safeDuration,
      safeMax,
    ));
    if (waitMs <= 0) return;
    await sleep(waitMs + 1);
  }
}

export async function closeRedisCoordination(): Promise<void> {
  if (redis.status === 'wait') {
    redis.disconnect();
    return;
  }
  await redis.quit();
}
