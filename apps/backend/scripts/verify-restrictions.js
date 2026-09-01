/**
 * Per-user restrictions: what they withdraw, and what they must not.
 *
 * ## Why this gate exists
 *
 * A restriction is a security control whose failure is silent in the dangerous
 * direction. A restriction that gates nothing looks identical, from every
 * screen, to one that works: the checkbox is ticked, the admin believes the
 * user is barred, and the user carries on exporting.
 *
 * This codebase has now shipped that shape four times — `autoProvisionGateway`
 * declared and unenforced until E5d, `allowedChannels` missing from the QR
 * pairing route, the tenant `Keyword` model whose entries never matched, and a
 * fifth caught during this very change: the first draft keyed restrictions on
 * the prefixes `settings:`, `team:`, `channel:`, `webhook:` and `integration:`,
 * **none of which exist** in the permission table. Four of five restrictions
 * would have gated nothing at all.
 *
 * So the assertions run in both directions. Half prove a restricted operation
 * is withdrawn; the other half prove the restriction does not take anything it
 * was not meant to — an over-broad rule that quietly removes `contact:read`
 * from a supervisor is its own outage.
 *
 * Hermetic: `permissionsForUser` is a pure function over the permission table.
 * No database, no Redis, no Docker, so this cannot go red for environmental
 * reasons.
 */
const { permissionsForRole, permissionsForUser } = require('../dist/middleware/rbac.middleware');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`[PASS] ${label}`);
  } else {
    failed += 1;
    console.log(`[FAIL] ${label}${detail ? `: ${detail}` : ''}`);
  }
}

/** Operations a restriction must remove, and operations it must leave alone. */
const CASES = [
  {
    flag: 'restrictDataExport',
    role: 'SUPERVISOR',
    removes: ['contact:export'],
    keeps: ['contact:read', 'contact:update', 'campaign:send', 'analytics:read'],
  },
  {
    flag: 'restrictContactDeletion',
    role: 'ADMIN',
    removes: ['contact:delete'],
    keeps: ['contact:read', 'contact:update', 'contact:export', 'segment:delete'],
  },
  {
    flag: 'restrictWorkspaceSettings',
    role: 'ADMIN',
    removes: ['system:config', 'user:create', 'user:update', 'user:delete', 'user:list'],
    keeps: ['contact:read', 'conversation:read', 'campaign:send', 'workflow:manage'],
  },
  {
    flag: 'restrictWorkflows',
    role: 'SUPERVISOR',
    removes: ['workflow:manage', 'workflow:view'],
    keeps: ['contact:read', 'conversation:assign', 'campaign:create'],
  },
];

function main() {
  for (const testCase of CASES) {
    const unrestricted = permissionsForRole(testCase.role);
    const restricted = permissionsForUser(testCase.role, { [testCase.flag]: true });

    for (const operation of testCase.removes) {
      // Guard against a case that proves nothing: if the role never held the
      // operation, "it is absent when restricted" is trivially true and would
      // pass against a restriction that does nothing whatsoever.
      check(
        `${testCase.flag}: ${testCase.role} holds ${operation} to begin with`,
        unrestricted.includes(operation),
        'the role does not hold it, so this case cannot prove anything',
      );
      check(
        `${testCase.flag}: withdraws ${operation}`,
        !restricted.includes(operation),
      );
    }

    for (const operation of testCase.keeps) {
      check(
        `${testCase.flag}: leaves ${operation} alone`,
        restricted.includes(operation),
      );
    }
  }

  // An unrestricted user is exactly their role — no rule fires by accident.
  for (const role of ['ADMIN', 'SUPERVISOR', 'AGENT', 'VIEWER', 'FINANCE']) {
    check(
      `${role} with no restrictions equals the plain role`,
      JSON.stringify(permissionsForUser(role, {})) === JSON.stringify(permissionsForRole(role)),
    );
    check(
      `${role} with undefined restrictions equals the plain role`,
      JSON.stringify(permissionsForUser(role)) === JSON.stringify(permissionsForRole(role)),
    );
  }

  // Combining restrictions subtracts both rather than only the first match.
  const both = permissionsForUser('ADMIN', { restrictDataExport: true, restrictContactDeletion: true });
  check('two restrictions on one user subtract both',
    !both.includes('contact:export') && !both.includes('contact:delete'));
  check('and still leave everything else', both.includes('contact:read'));

  console.log('');
  console.log(`${passed}/${passed + failed} checks passed.`);
  if (failed > 0) process.exitCode = 1;
}

main();
