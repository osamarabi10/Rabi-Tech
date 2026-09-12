/**
 * How large each gate is known to be, from a green run somebody watched.
 *
 * `verify-gate-sweep.js` refuses a sweep in which any gate reports fewer checks
 * than its floor. Exit codes cannot see a suite that shrank: on 2026-09-09 the
 * tenancy gate fell from `157/157` to `20/21` because the sweep invoked the
 * harness directly and the harness refuses that — the whole database section
 * silently not run, for two days, while the sweep was read as meaningful.
 *
 * `null` means the gate reports no count at all. A typechecker prints nothing
 * when it is happy, and `mojibake: none found.` carries no number. Those are
 * recorded explicitly rather than left out, because a gate missing from this
 * file is a gate with no floor, which is how the class returns.
 *
 * Raise a floor when a gate genuinely grows — the diff is the review. Never
 * lower one to make a run pass. A gate that legitimately shrinks (a check
 * deleted on purpose) is a deliberate commit that says so.
 */
module.exports = {
  /** Prints nothing when clean. */
  tsc: null,

  /**
   * 164, observed green 2026-09-11 through `npm run test:tenancy`, which is
   * the only invocation that gives the harness its isolated database. The same
   * run reported 20/21 when invoked directly, which is what this floor exists
   * to refuse.
   */
  tenancy: 164,

  capabilities: 18,

  /**
   * 8, from `.gate-runs/part2-20260908-postcommit/` — `8/8 scenarios
   * unchanged.` Not observed green since: the gate seeds eight organizations
   * through the real signup path, and the running backend caps signup at three
   * per hour, so five are refused with 429 on every run. The floor records the
   * size the proof must reach, and the gate's own failure is a separate
   * decision.
   */
  'entitlement-proof': 8,

  'lazy-provisioning': 11,
  'session-routing': 12,
  secrets: 12,
  dunning: 14,
  'backup-replication': 30,

  /** Three checks: the response, the recorded outcome, and the recorded reason. */
  'inbound-durability': 3,

  /**
   * Six: three that the purchased terms survive a payment, one that an edition
   * change still moves, and two source checks that both payment paths share the
   * one writer.
   */
  'terms-pin': 6,

  /**
   * Eleven: five on the purchase itself, one that an unreadable checkout is
   * refused rather than resolved to current, three on the route's scope and
   * exemption, one that the manual destination exists, and two that a session
   * is offered a purchase rather than a signup form.
   */
  'upgrade-path': 11,

  /** Prints nothing when clean. */
  'frontend-tsc': null,

  /** Reports backlog counts, never an N/M. */
  'frontend-i18n': null,

  /** `mojibake: none found.` */
  'frontend-mojibake': null,
};
