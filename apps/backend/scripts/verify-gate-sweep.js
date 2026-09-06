#!/usr/bin/env node
/**
 * Prove a gate sweep actually completed.
 *
 * ## Why this exists
 *
 * On 2026-09-06 a background shell running the final sweep was reaped for
 * memory after the entitlement proof had written its log and before the three
 * frontend gates ran. The gap was noticed and filled — but only because the
 * missing log files happened to be looked at. Nothing failed. Nothing said
 * anything. A partial sweep is indistinguishable from a complete one when the
 * only evidence is the results that *did* arrive.
 *
 * Absence of a result must fail loudly, not read as silence.
 *
 * ## How
 *
 * Each gate writes its summary to a named file under a run directory. This
 * asserts every expected file exists, is newer than the run started, carries
 * a summary rather than a truncated stub, and records exit 0. Missing is a
 * failure, stale is a failure, empty is a failure, and so is a gate that ran
 * and reported non-zero.
 *
 * The exit code is checked because the first version of this did not, and
 * labelled a **failing** tenancy run `[PASS]`. It had proved the gate
 * reported, which is not the same as proving it passed — a manifest that can
 * say PASS about a failure is the exact shape of problem it exists to end.
 *
 * Usage:
 *   node scripts/verify-gate-sweep.js <run-dir> <started-epoch-seconds>
 */
const fs = require('fs');
const path = require('path');

/**
 * The sweep, named once.
 *
 * Adding a gate means adding it here. That is the point: the manifest is the
 * list of what a complete run means, and a gate absent from it is a gate whose
 * absence nobody will notice.
 */
const EXPECTED = [
  'tsc',
  'tenancy',
  'capabilities',
  'entitlement-proof',
  'lazy-provisioning',
  'session-routing',
  'secrets',
  'dunning',
  'backup-replication',
  'frontend-tsc',
  'frontend-i18n',
  'frontend-mojibake',
];

function main() {
  const [runDir, startedRaw] = process.argv.slice(2);
  if (!runDir || !startedRaw) {
    process.stdout.write('usage: verify-gate-sweep.js <run-dir> <started-epoch-seconds>\n');
    process.exitCode = 1;
    return;
  }
  const startedMs = Number(startedRaw) * 1000;
  if (!Number.isFinite(startedMs)) {
    process.stdout.write(`[FAIL] sweep: start time ${JSON.stringify(startedRaw)} is not a number\n`);
    process.exitCode = 1;
    return;
  }

  const problems = [];
  for (const name of EXPECTED) {
    const file = path.join(runDir, `${name}.log`);
    if (!fs.existsSync(file)) {
      problems.push(`${name}: NO RESULT — the gate did not run, or its shell died before writing`);
      continue;
    }
    const stat = fs.statSync(file);
    if (stat.mtimeMs < startedMs) {
      problems.push(
        `${name}: STALE — written ${new Date(stat.mtimeMs).toISOString()}, `
        + `before this run started at ${new Date(startedMs).toISOString()}`,
      );
      continue;
    }
    const body = fs.readFileSync(file, 'utf8').trim();
    if (!body) {
      problems.push(`${name}: EMPTY — a gate that printed nothing has reported nothing`);
      continue;
    }
    const lines = body.split(/\r?\n/);
    const exitLine = lines.find((line) => /^exit=/.test(line));
    if (!exitLine) {
      problems.push(`${name}: NO EXIT CODE — cannot tell a pass from a failure`);
      continue;
    }
    const code = Number(exitLine.slice('exit='.length).trim());
    const summary = lines[lines.length - 1].slice(0, 70);
    if (code !== 0) {
      problems.push(`${name}: FAILED exit=${code} — ${summary}`);
      continue;
    }
    process.stdout.write(`[PASS] ${name}: ${summary}\n`);
  }

  if (problems.length) {
    process.stdout.write('\nThe sweep did not pass:\n');
    for (const problem of problems) process.stdout.write(`  - ${problem}\n`);
    process.stdout.write(
      `\n${EXPECTED.length - problems.length}/${EXPECTED.length} gates green. `
      + 'A missing result and a failing one are both failures here.\n',
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`\n${EXPECTED.length}/${EXPECTED.length} gates green, all newer than the run start.\n`);
}

main();
