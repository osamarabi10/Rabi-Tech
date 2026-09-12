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
 * ## The count is checked too, since 2026-09-11
 *
 * On 2026-09-09 the tenancy harness gained a wrapper that gives it a
 * regenerated client and a disposable database, and refuses direct execution
 * because direct execution has neither. This script still invoked it directly.
 * The harness said exactly what was wrong and exited non-zero, so the sweep did
 * fail — but the number nobody read had gone from `157/157` to `20/21`: the
 * whole database section, silently not run, for two days.
 *
 * Exit codes cannot see that. A gate can pass while testing an eighth of what
 * it used to. So every gate that reports `N/M` carries a floor here, and a run
 * that reports fewer checks than the last green one is a failure — not a pass
 * with a smaller number.
 *
 * Usage:
 *   node scripts/verify-gate-sweep.js <run-dir> <started-epoch-seconds>
 */
const fs = require('fs');
const path = require('path');

/**
 * The size each gate is known to have reached, from a green run somebody
 * watched. `null` means the gate does not report a count at all — a
 * typechecker prints nothing when it is happy — and that is recorded
 * explicitly rather than omitted, because an omission is how a gate slips in
 * with no floor and no one notices.
 *
 * Raise a floor when a gate legitimately grows; the diff is the review. Never
 * lower one to make a run pass.
 */
const FLOORS = require('./gate-floors');

/** The check count a gate's summary line reports, or null if it reports none. */
function reportedCount(summary) {
  const match = /(\d+)\s*\/\s*(\d+)/.exec(summary);
  return match ? Number(match[2]) : null;
}

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
  'inbound-durability',
  'terms-pin',
  'upgrade-path',
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
    if (!(name in FLOORS)) {
      problems.push(
        `${name}: NO FLOOR — gate-floors.js does not record how large this gate is, `
        + 'so a run that shrank would read as a pass',
      );
      continue;
    }
    const floor = FLOORS[name];
    const count = reportedCount(summary);
    if (floor === null) {
      process.stdout.write(`[PASS] ${name}: ${summary}\n`);
      continue;
    }
    if (count === null) {
      problems.push(
        `${name}: NO COUNT — a floor of ${floor} is recorded, but the summary reports no N/M: ${summary}`,
      );
      continue;
    }
    if (count < floor) {
      problems.push(
        `${name}: SHRANK — reported ${count} checks, floor is ${floor}. `
        + 'A gate that passes while testing less than it used to is a failure, not a pass',
      );
      continue;
    }
    const grew = count > floor ? ` (grew past its floor of ${floor} — raise it in gate-floors.js)` : '';
    process.stdout.write(`[PASS] ${name}: ${summary}${grew}\n`);
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
