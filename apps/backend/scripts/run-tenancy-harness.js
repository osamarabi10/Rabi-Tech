#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(ROOT, '..', '..');
const DATABASE_PREFIX = 'rabitech_tenancy_';
const REDIS_CONTAINER_PREFIX = 'rabitech-tenancy-redis-';
const REDIS_CONTAINER_LABEL = 'com.rabitech.tenancy-harness=1';
const REDIS_IMAGE = 'redis:7-alpine';
const HARNESS_MODE = process.argv[2] || 'tenancy';
const HARNESS_CONFIG = {
  tenancy: {
    script: 'scripts/tenancy-bleed-harness.js',
    port: Number(process.env.HARNESS_BACKEND_PORT || 4707),
  },
  'public-api': {
    script: 'scripts/verify-public-api.js',
    port: Number(process.env.VERIFY_API_PORT || 4199),
  },
}[HARNESS_MODE];
const OVERRIDE_FLAG = 'RABITECH_TENANCY_ALLOW_UNEXPECTED_SESSIONS';
const OVERRIDE_OWNER = 'RABITECH_TENANCY_ISOLATION_OVERRIDE_BY';
const prismaCli = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
const typescriptCli = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const prismaLint = path.join(ROOT, 'scripts', 'lint-prisma-client.js');
const schemaPath = path.join(ROOT, 'prisma', 'schema.prisma');
const generatedSchemaPath = path.join(ROOT, 'node_modules', '.prisma', 'client', 'schema.prisma');

require('dotenv').config({ path: path.join(REPO_ROOT, '.env') });

function fail(message) {
  process.stderr.write(`TENANCY HARNESS REFUSED: ${message}\n`);
  process.exitCode = 1;
}

function substantive(value) {
  const text = String(value || '').trim();
  return text.length >= 3 && !/^\d+$/.test(text) ? text : null;
}

function isolationOverride() {
  if (process.env[OVERRIDE_FLAG] !== '1') return null;
  const owner = substantive(process.env[OVERRIDE_OWNER]);
  if (!owner) {
    throw new Error(`${OVERRIDE_FLAG}=1 requires a substantive ${OVERRIDE_OWNER}`);
  }
  return owner;
}

function printWaiver(owner) {
  const line = `ISOLATION GUARANTEE WAIVED BY ${owner}: THIS RUN IS NOT CERTIFICATION-GRADE.`;
  process.stderr.write(`\n${'!'.repeat(line.length)}\n${line}\n${'!'.repeat(line.length)}\n\n`);
}

function csvRows(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('INFO:'))
    .map((line) => {
      const fields = [];
      line.replace(/"((?:[^"]|"")*)"(?:,|$)/g, (_match, field) => {
        fields.push(field.replace(/""/g, '"'));
        return '';
      });
      return fields;
    })
    .filter((fields) => fields.length > 0);
}

function windowsProcessInventory() {
  const script = [
    'Get-CimInstance Win32_Process',
    "Select-Object ProcessId,Name,CommandLine",
    'ConvertTo-Json -Compress',
  ].join(' | ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  const parsed = JSON.parse(result.stdout);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
    pid: Number(row.ProcessId),
    name: String(row.Name || ''),
    command: String(row.CommandLine || ''),
  }));
}

function processInventory() {
  if (process.platform === 'win32') return windowsProcessInventory();
  const result = spawnSync('ps', ['-eo', 'pid=,comm=,args='], { encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    return match ? [{ pid: Number(match[1]), name: match[2], command: match[3] }] : [];
  });
}

function dockerCommand(args, options = {}) {
  const result = spawnSync('docker', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: options.timeout ?? 30_000,
  });
  if (result.status !== 0 || result.error) {
    if (options.allowFailure) return result;
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    throw new Error(
      `Docker command failed: docker ${args.join(' ')}\n`
      + `${output || result.error?.message || `exit ${result.status}`}`,
    );
  }
  return result;
}

function assertRedisContainerName(name) {
  if (!new RegExp(`^${REDIS_CONTAINER_PREFIX}[a-z0-9-]+$`).test(name)) {
    throw new Error(`Unsafe disposable Redis container name: ${name}`);
  }
}

function removeRedisContainer(name) {
  assertRedisContainerName(name);
  const result = dockerCommand(['rm', '--force', name], { allowFailure: true });
  if (result.status !== 0 && !String(result.stderr || '').includes('No such container')) {
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    throw new Error(`Could not remove disposable Redis container ${name}: ${output}`);
  }
}

function cleanStaleRedisContainers() {
  const result = dockerCommand([
    'ps', '--all', '--filter', `label=${REDIS_CONTAINER_LABEL}`, '--format', '{{.Names}}',
  ]);
  const stale = result.stdout
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter((name) => name.startsWith(REDIS_CONTAINER_PREFIX));
  process.stdout.write(`Harness preflight: found ${stale.length} stale disposable Redis container(s).\n`);
  if (stale.length > 2) {
    process.stderr.write(
      `HARNESS HEALTH WARNING: ${stale.length} stale Redis containers indicate repeated unclean exits.\n`,
    );
  }
  for (const name of stale) removeRedisContainer(name);
  if (stale.length > 0) {
    process.stdout.write(`Harness preflight: removed ${stale.length} stale disposable Redis container(s).\n`);
  }
}

function startDisposableRedis() {
  const name = `${REDIS_CONTAINER_PREFIX}${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  assertRedisContainerName(name);
  let started = false;
  try {
    dockerCommand(['image', 'inspect', REDIS_IMAGE]);
    dockerCommand([
      'run', '--detach', '--rm',
      '--name', name,
      '--label', REDIS_CONTAINER_LABEL,
      '--publish', '127.0.0.1::6379',
      REDIS_IMAGE,
    ], { timeout: 120_000 });
    started = true;

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const ping = dockerCommand(['exec', name, 'redis-cli', 'ping'], {
        allowFailure: true,
        timeout: 5_000,
      });
      if (ping.status === 0 && ping.stdout.trim() === 'PONG') {
        const portResult = dockerCommand(['port', name, '6379/tcp']);
        const portMatch = portResult.stdout.match(/127\.0\.0\.1:(\d+)/);
        if (!portMatch) {
          throw new Error(`Docker did not report a loopback port for disposable Redis ${name}`);
        }
        const url = `redis://127.0.0.1:${portMatch[1]}`;
        process.stdout.write(`Harness preflight: created fresh disposable Redis ${name}.\n`);
        return { name, url };
      }
    }
    throw new Error(`Disposable Redis ${name} did not answer PING within 30000ms`);
  } catch (error) {
    if (started) removeRedisContainer(name);
    throw error;
  }
}

function refuseHostBackendWatchers() {
  const root = ROOT.replace(/\\/g, '/').toLowerCase();
  const watchers = processInventory().filter((row) => {
    const command = row.command.replace(/\\/g, '/').toLowerCase();
    return row.pid !== process.pid
      && command.includes(root)
      && /(ts-node-dev|src\/index\.ts|dist\/index\.js)/.test(command);
  });
  if (watchers.length === 0) return;
  const detail = watchers
    .map((row) => `PID ${row.pid} (${row.name}): ${row.command}`)
    .join('\n');
  throw new Error(`RabiTech backend process is running against this checkout:\n${detail}`);
}

function windowsPrismaLockOwners() {
  const result = spawnSync(
    'tasklist.exe',
    ['/m', 'query_engine-windows.dll.node', '/fo', 'csv', '/nh'],
    { encoding: 'utf8', timeout: 10_000 },
  );
  if (result.status !== 0) return [];
  const inventory = new Map(processInventory().map((row) => [row.pid, row]));
  return csvRows(result.stdout).flatMap((fields) => {
    const pid = Number(fields[1]);
    if (!Number.isInteger(pid)) return [];
    const process = inventory.get(pid);
    return [{ pid, name: fields[0], command: process?.command || '<command unavailable>' }];
  });
}

function prismaLockOwners() {
  if (process.platform === 'win32') return windowsPrismaLockOwners();
  const result = spawnSync('lsof', [generatedSchemaPath], { encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).slice(1).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    const pid = Number(fields[1]);
    return Number.isInteger(pid) ? [{ pid, name: fields[0], command: line.trim() }] : [];
  });
}

function regeneratePrismaClient() {
  process.stdout.write('Harness preflight: regenerating Prisma Client from checked-out schema.\n');
  const result = spawnSync(process.execPath, [prismaCli, 'generate', '--schema', schemaPath], {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.status !== 0 || result.error) {
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    const owners = prismaLockOwners();
    const ownerText = owners.length
      ? owners.map((row) => `PID ${row.pid} (${row.name}): ${row.command}`).join('\n')
      : '<no query-engine owner could be identified>';
    throw new Error(
      `Prisma Client regeneration failed; the existing generated client will not be used.\n`
      + `${output || result.error?.message || `exit ${result.status}`}\n`
      + `Processes holding the Prisma query engine:\n${ownerText}`,
    );
  }
  const normalizeSchema = (file) => fs.readFileSync(file, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
  const checkedOut = normalizeSchema(schemaPath);
  const generated = normalizeSchema(generatedSchemaPath);
  if (checkedOut !== generated) {
    throw new Error('Prisma generation returned success but the generated schema differs from the checkout');
  }
  process.stdout.write('Harness preflight: generated Prisma Client matches the normalized checked-out schema.\n');
}

function buildBackend() {
  const steps = [
    { label: 'TypeScript build', args: [typescriptCli] },
    { label: 'Prisma constructor lint', args: [prismaLint] },
  ];
  for (const step of steps) {
    const result = spawnSync(process.execPath, step.args, {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
      timeout: 300_000,
    });
    if (result.status !== 0 || result.error) {
      const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
      throw new Error(
        `${step.label} failed after Prisma Client regeneration.\n`
        + `${output || result.error?.message || `exit ${result.status}`}`,
      );
    }
  }
  process.stdout.write('Harness preflight: built backend after Prisma Client regeneration.\n');
}

function databaseUrl(baseUrl, databaseName, applicationName) {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  url.searchParams.delete('schema');
  if (applicationName) url.searchParams.set('application_name', applicationName);
  return url.toString();
}

function quoteIdentifier(value) {
  if (!new RegExp(`^${DATABASE_PREFIX}[a-z0-9_]+$`).test(value)) {
    throw new Error(`Unsafe disposable database name: ${value}`);
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function testPortOwners(port) {
  if (process.platform !== 'win32') return [];
  const result = spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) return [];
  const inventory = new Map(processInventory().map((row) => [row.pid, row]));
  const pids = new Set();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (match && Number(match[1]) === port) pids.add(Number(match[2]));
  }
  return [...pids].map((pid) => inventory.get(pid) || { pid, name: '<unknown>', command: '<command unavailable>' });
}

async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (error) => reject(error));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  }).catch((error) => {
    const owners = testPortOwners(port);
    const detail = owners.length
      ? owners.map((row) => `PID ${row.pid} (${row.name}): ${row.command}`).join('\n')
      : '<owner unavailable>';
    throw new Error(`test backend port ${port} is unavailable (${error.code || error.message})\n${detail}`);
  });
}

async function databaseSessions(admin, databaseName) {
  return admin.$queryRawUnsafe(
    `SELECT pid, application_name AS "applicationName", client_addr::text AS "clientAddress", state
       FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()
      ORDER BY pid`,
    databaseName,
  );
}

function formatSessions(databaseName, sessions) {
  return sessions.map((row) => (
    `${databaseName}: PostgreSQL PID ${row.pid}, application=${row.applicationName || '<unset>'}, `
    + `client=${row.clientAddress || '<local>'}, state=${row.state || '<unknown>'}`
  )).join('\n');
}

async function refuseUnexpectedSessions(admin, databaseName, overrideOwner) {
  const sessions = await databaseSessions(admin, databaseName);
  if (sessions.length === 0) return;
  const detail = formatSessions(databaseName, sessions);
  if (!overrideOwner) throw new Error(`unexpected process holds the disposable database:\n${detail}`);
  printWaiver(overrideOwner);
  process.stderr.write(`${detail}\n`);
}

async function dropDatabase(admin, databaseName, force) {
  const clause = force ? ' WITH (FORCE)' : '';
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}${clause}`);
}

async function cleanStaleDatabases(admin, overrideOwner) {
  const stale = await admin.$queryRawUnsafe(
    'SELECT datname FROM pg_database WHERE starts_with(datname, $1) ORDER BY datname',
    DATABASE_PREFIX,
  );
  process.stdout.write(`Harness preflight: found ${stale.length} stale disposable database(s).\n`);
  if (stale.length > 2) {
    process.stderr.write(`HARNESS HEALTH WARNING: ${stale.length} stale databases indicate repeated unclean exits.\n`);
  }
  for (const row of stale) {
    await refuseUnexpectedSessions(admin, row.datname, overrideOwner);
    await dropDatabase(admin, row.datname, Boolean(overrideOwner));
  }
  if (stale.length > 0) process.stdout.write(`Harness preflight: removed ${stale.length} stale disposable database(s).\n`);
}

function applyMigrations(targetUrl) {
  const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: targetUrl },
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (result.status !== 0 || result.error) {
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    throw new Error(
      `Could not migrate the disposable database.\n`
      + `${output || result.error?.message || `exit ${result.status}`}`,
    );
  }
  process.stdout.write('Harness preflight: applied migrations to the disposable database.\n');
}

/**
 * The harness's own summary line, remembered so it can be printed last.
 *
 * The sweep reads a gate's result as the final line of its output, and this
 * wrapper prints cleanup after the harness has finished — so without this the
 * gate's recorded summary is `Harness cleanup: removed disposable Redis …`, a
 * green result that says nothing about how many checks ran. That is how a
 * suite shrinks unnoticed, which is the defect this wrapper's own history is
 * about.
 */
let harnessSummary = '';

async function runHarness(targetUrl, redisUrl, redisContainerName, databaseName, overrideOwner) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HARNESS_CONFIG.script], {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: targetUrl,
        REDIS_URL: redisUrl,
        HARNESS_BACKEND_PORT: String(HARNESS_CONFIG.port),
        VERIFY_API_PORT: String(HARNESS_CONFIG.port),
        RABITECH_TENANCY_DATABASE_NAME: databaseName,
        RABITECH_TENANCY_REDIS_CONTAINER: redisContainerName,
        RABITECH_TENANCY_WRAPPER_PID: String(process.pid),
      },
      // stdout is piped rather than inherited so the summary line can be
      // remembered and re-printed after cleanup; it is relayed unchanged as it
      // arrives, so the run still reads live.
      stdio: ['inherit', 'pipe', 'inherit'],
    });
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) harnessSummary = line;
    });
    child.stdout.on('end', () => {
      if (pending.trim()) harnessSummary = pending;
    });
    const relay = (signal) => {
      if (child.exitCode === null) child.kill(signal);
    };
    process.once('SIGINT', relay);
    process.once('SIGTERM', relay);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      process.removeListener('SIGINT', relay);
      process.removeListener('SIGTERM', relay);
      resolve(signal ? 1 : code ?? 1);
    });
  }).then((code) => {
    if (overrideOwner) {
      printWaiver(overrideOwner);
      return code === 0 ? 2 : code;
    }
    return code;
  });
}

async function main() {
  const overrideOwner = isolationOverride();
  if (overrideOwner) printWaiver(overrideOwner);
  if (!HARNESS_CONFIG) throw new Error(`Unknown isolated harness mode: ${HARNESS_MODE}`);
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
  if (!Number.isInteger(HARNESS_CONFIG.port) || HARNESS_CONFIG.port < 1024 || HARNESS_CONFIG.port > 65535) {
    throw new Error(`Invalid harness port: ${HARNESS_CONFIG.port}`);
  }

  refuseHostBackendWatchers();
  await assertPortFree(HARNESS_CONFIG.port);
  regeneratePrismaClient();
  if (HARNESS_MODE === 'public-api') buildBackend();

  const { PrismaClient } = require('@prisma/client');
  const baseUrl = process.env.DATABASE_URL;
  const maintenanceUrl = databaseUrl(baseUrl, 'postgres', `rabitech-tenancy-bootstrap-${process.pid}`);
  const admin = new PrismaClient({ datasources: { db: { url: maintenanceUrl } } });
  const databaseName = `${DATABASE_PREFIX}${process.pid}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  let redisContainer = null;
  let created = false;
  let exitCode = 1;

  try {
    await cleanStaleDatabases(admin, overrideOwner);
    cleanStaleRedisContainers();
    redisContainer = startDisposableRedis();
    await admin.$executeRawUnsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    created = true;
    await refuseUnexpectedSessions(admin, databaseName, overrideOwner);
    const targetUrl = databaseUrl(baseUrl, databaseName, `rabitech-tenancy-${process.pid}`);
    process.stdout.write(`Harness preflight: created fresh disposable database ${databaseName}.\n`);
    if (HARNESS_MODE === 'public-api') applyMigrations(targetUrl);
    exitCode = await runHarness(
      targetUrl,
      redisContainer.url,
      redisContainer.name,
      databaseName,
      overrideOwner,
    );
  } finally {
    try {
      if (created) {
        const sessions = await databaseSessions(admin, databaseName).catch(() => []);
        if (sessions.length > 0) {
          process.stderr.write(`Harness cleanup: terminating remaining disposable-database sessions:\n${formatSessions(databaseName, sessions)}\n`);
        }
        await dropDatabase(admin, databaseName, true);
        process.stdout.write(`Harness cleanup: dropped disposable database ${databaseName}.\n`);
      }
    } finally {
      try {
        if (redisContainer) {
          removeRedisContainer(redisContainer.name);
          process.stdout.write(`Harness cleanup: removed disposable Redis ${redisContainer.name}.\n`);
        }
      } finally {
        await admin.$disconnect();
      }
    }
  }
  // Last line is the result, after every cleanup message. Repeating it is the
  // point: whatever reads this gate reads its count, not the housekeeping that
  // happened to come after.
  if (harnessSummary) process.stdout.write(`${harnessSummary}\n`);
  process.exitCode = exitCode;
}

main().catch((error) => {
  fail(error instanceof Error ? error.stack || error.message : String(error));
});
