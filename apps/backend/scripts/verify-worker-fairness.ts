import assert from 'assert';
import {
  closeRedisCoordination,
  coordinationKey,
  waitForRedisRateLimit,
  withFifoRedisLock,
} from '../src/lib/redis-coordination';

async function main(): Promise<void> {
  const suffix = `${process.pid}-${Date.now()}`;
  const sameKey = coordinationKey('fairness-test', suffix, 'same');
  const order: number[] = [];
  let active = 0;
  let maxActive = 0;

  await Promise.all([1, 2, 3].map((value) => withFifoRedisLock(sameKey, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(value);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active -= 1;
  })));

  assert.equal(maxActive, 1, 'same key must never overlap');
  assert.deepEqual(order, [1, 2, 3], 'same key must preserve arrival order');

  let concurrent = 0;
  let maxConcurrent = 0;
  await Promise.all(['a', 'b'].map((value) => withFifoRedisLock(
    coordinationKey('fairness-test', suffix, value),
    async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 50));
      concurrent -= 1;
    },
  )));
  assert.equal(maxConcurrent, 2, 'different keys should run concurrently');

  const rateKey = coordinationKey('fairness-rate-test', suffix);
  const startedAt = Date.now();
  await waitForRedisRateLimit(rateKey, 1, 80);
  await waitForRedisRateLimit(rateKey, 1, 80);
  assert(Date.now() - startedAt >= 75, 'rate limiter must delay the second send');

  console.log('3/3 worker fairness checks passed.');
}

main()
  .finally(() => closeRedisCoordination())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
