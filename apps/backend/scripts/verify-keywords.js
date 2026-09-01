/**
 * Keyword detection across all three languages this platform serves.
 *
 * ## Why this gate exists
 *
 * `detectPriority` normalised with `replace(/[^؀-ۿ\s]/g, '')` — keep
 * Arabic, discard everything else. A Hebrew or English message therefore
 * normalised to whitespace and matched nothing: no priority, no category, no
 * CRITICAL routing. Not a near-miss; total, for two of the three languages.
 *
 * It also silently broke the tenant-extensible `Keyword` model, which is worse.
 * A subscriber could add "urgent" through Settings → Keywords, see it saved, and
 * never have it match, because the normaliser ran before their list was read.
 *
 * Nothing caught it. `tsc` is satisfied by a regex. `check:i18n` covers the
 * frontend dictionary, not backend matching. The tenancy harness proves
 * isolation, not language coverage. So the class of bug — *a matcher that
 * silently discards input* — had no gate at all, and this is it.
 *
 * ## What the negative cases are for
 *
 * Adding English keywords to a substring matcher is a false-positive generator:
 * "how" matches "however" and "shower". The matcher therefore uses whole-word
 * semantics for Latin and substring for Arabic and Hebrew, because those attach
 * affixes to the stem. Half these checks exist to prove the Latin half does not
 * over-match, which is the failure that would arrive quietly as mis-routed
 * CRITICAL conversations.
 *
 * Runs against the compiled output in dist/, like every other gate here.
 */
require('./load-env');

const { detectPriority, detectMarketingLead } = require('../dist/constants/keywords');
const { runAsOrganization } = require('../dist/lib/tenant-context');

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

/** A tenant id that owns nothing, so no custom keyword rows can skew a result. */
const PROBE_ORG = 'verify_keywords_probe_org';

const PRIORITY_CASES = [
  // Arabic must be byte-for-byte unaffected by widening the character class.
  ['عاجل المشكلة كبيرة', 'CRITICAL', 'arabic critical is unchanged'],
  ['مشكلة بالنت', 'HIGH', 'arabic high is unchanged'],
  ['سؤال بسيط', 'MEDIUM', 'arabic medium is unchanged'],
  ['شكرًا الك', 'LOW', 'arabic low is unchanged'],

  // Hebrew: previously normalised to whitespace and matched nothing.
  ['דחוף, יש תקלה', 'CRITICAL', 'hebrew critical is detected'],
  ['יש בעיה עם החיבור', 'HIGH', 'hebrew high is detected'],
  ['שאלה קטנה', 'MEDIUM', 'hebrew medium is detected'],
  ['תודה רבה', 'LOW', 'hebrew low is detected'],

  // English: same.
  ['this is urgent', 'CRITICAL', 'english critical is detected'],
  ['not working at all', 'HIGH', 'english high is detected'],
  ['thanks!', 'LOW', 'english punctuation is stripped before matching'],
  ['URGENT', 'CRITICAL', 'english matching is case-insensitive'],

  // The negatives. Each of these WOULD match under substring semantics.
  ['I took a shower', null, 'shower does not match the keyword how'],
  ['however you like', null, 'however does not match the keyword how'],
  ['issued a refund', null, 'issued does not match the keyword issue'],

  // Mixed-script, which is ordinary here rather than exotic.
  ['مرحبا, this is urgent', 'CRITICAL', 'a latin keyword matches inside an arabic sentence'],
];

async function main() {
  await runAsOrganization(PROBE_ORG, async () => {
    for (const [text, expected, label] of PRIORITY_CASES) {
      const result = await detectPriority(text);
      check(label, result.priority === expected, `expected ${expected}, got ${result.priority}`);
    }

    // detectMarketingLead carried an identical Arabic-only strip. It shares the
    // normaliser now, so one case is enough to prove they did not diverge again.
    const arabicLead = await detectMarketingLead('بدي أعرف السعر');
    check('lead detection still reads arabic', arabicLead.leadCategory !== null,
      `got ${arabicLead.leadCategory}`);
    const latinNoise = await detectMarketingLead('the pricessor is fine');
    check('lead detection does not match a latin keyword inside a longer word',
      latinNoise.matchedKeyword === null, `matched ${latinNoise.matchedKeyword}`);
  });

  console.log('');
  console.log(`${passed}/${passed + failed} checks passed.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
