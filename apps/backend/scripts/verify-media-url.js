/**
 * Signed media URLs: they work, and they only work for what they name.
 *
 * A browser cannot put an Authorization header on an `<img src>`, so media
 * authenticates itself in the URL. That makes the signature the whole security
 * boundary, and a boundary nobody tests is a boundary nobody has.
 *
 * Pure functions over crypto — no database, nothing to clean up.
 *
 * It still loads the environment, and the reason is worth stating: `signed-url`
 * falls back to `process.env.JWT_SECRET || 'default-secret'`. Without the
 * loader this gate signs and verifies with that constant and passes, proving a
 * round trip under a key production does not use. Loading the real secret makes
 * the check exercise the real signature. See D-12.
 */
require('./load-env');

const {
  generateMediaToken,
  generateMediaProxyToken,
  verifyMediaToken,
  verifyMediaProxyToken,
} = require('../dist/utils/signed-url');
const { signMediaUrl } = require('../dist/utils/media-url');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('[PASS] ' + label);
  } else {
    failed += 1;
    console.log('[FAIL] ' + label + (detail ? ' — ' + detail : ''));
  }
}

const MSG = 'false_220473606570075@lid_3A5B3162AA0903B8CED2';
const SESSION = 'ostudio-primary';
const ORG = 'org_rabitech_0';
const OTHER = 'org_someone_else';

// ── round trip ────────────────────────────────────────────────────────────
const token = generateMediaToken(MSG, SESSION, ORG);
const verified = verifyMediaToken(token);
check('a signed message token verifies', verified !== null);
check('and returns the message id intact', verified?.msgId === MSG, verified?.msgId);
check('the session intact', verified?.session === SESSION, verified?.session);
check('and the organization it was signed for', verified?.organizationId === ORG, verified?.organizationId);

// ── tampering ─────────────────────────────────────────────────────────────
check('a token with a flipped signature is refused',
  verifyMediaToken(token.slice(0, -1) + (token.slice(-1) === 'a' ? 'b' : 'a')) === null);
check('a token with the organization swapped is refused',
  verifyMediaToken(token.replace(ORG, OTHER)) === null);
check('a token with the message id swapped is refused',
  verifyMediaToken(token.replace(MSG, 'false_someone_else@lid_X')) === null);
check('garbage is refused', verifyMediaToken('not-a-token') === null);
check('an empty token is refused', verifyMediaToken('') === null);

// ── expiry ────────────────────────────────────────────────────────────────
const expired = (() => {
  const parts = token.split(':');
  // Rebuild with an expiry in the past; the signature no longer matches, which
  // is the point — an expired token cannot simply be re-dated.
  parts[parts.length - 2] = String(Math.floor(Date.now() / 1000) - 10);
  return parts.join(':');
})();
check('a re-dated token is refused', verifyMediaToken(expired) === null);

// ── the URL variant ───────────────────────────────────────────────────────
const upstream = 'http://openwa:2785/api/media/abc?x=1';
const urlToken = generateMediaProxyToken(upstream, ORG);
const urlVerified = verifyMediaProxyToken(urlToken);
check('a signed upstream URL verifies', urlVerified !== null);
check('and survives the colons in the URL', urlVerified?.url === upstream, urlVerified?.url);
check('with its organization', urlVerified?.organizationId === ORG, urlVerified?.organizationId);

// ── what the messages route actually produces ─────────────────────────────
const stored =
  '/media-proxy/message?session=' + encodeURIComponent(SESSION) +
  '&msgId=' + encodeURIComponent(MSG) + '&type=image';
const signed = signMediaUrl(stored, ORG);
check('signMediaUrl adds a token', signed.includes('token='));

const params = new URL(signed, 'http://internal').searchParams;
const fromUrl = verifyMediaToken(params.get('token'));
check('the token in the URL verifies', fromUrl !== null);
check('and names the same message the URL does',
  fromUrl?.msgId === params.get('msgId'), fromUrl?.msgId);
check('signing twice does not double-sign', signMediaUrl(signed, ORG) === signed);
check('a non-proxy URL is left alone',
  signMediaUrl('https://example.test/a.jpg', ORG) === 'https://example.test/a.jpg');
check('null stays null', signMediaUrl(null, ORG) === null);

// ── D-29: no signing key means no signature, never a default one ──────────
//
// Four call sites used to sign with `JWT_SECRET || 'dev-secret'`. Because
// possession of a valid signature *is* the authorisation for media, branding
// and snippet assets, a predictable key does not weaken the check — it removes
// it, for every tenant at once, silently. The boot gate does not close this:
// outside production it only warns, and ALLOW_INSECURE_SECRETS=1 downgrades it
// to a log line, which is the state this deployment runs in today.
//
// So the assertion is that it THROWS. A test that only proved the signature
// changed would pass just as happily against a second hardcoded constant.
{
  const { signBrandingAsset } = require('../dist/modules/branding/branding.service');
  const { signSnippetAsset } = require('../dist/modules/snippets/snippet-storage');
  const previous = process.env.JWT_SECRET;

  const refuses = (label, fn) => {
    try {
      const out = fn();
      check(label, false, 'returned ' + JSON.stringify(out) + ' instead of throwing');
    } catch (error) {
      check(label, /JWT_SECRET/.test(String(error)), String(error).slice(0, 90));
    }
  };

  try {
    delete process.env.JWT_SECRET;
    refuses('media: no JWT_SECRET refuses to sign', () => generateMediaToken(MSG, SESSION, ORG));
    refuses('media: no JWT_SECRET refuses to verify', () => verifyMediaToken(token));
    refuses('branding: no JWT_SECRET refuses to sign', () => signBrandingAsset(ORG, 'logo', 'a.png'));
    refuses('snippets: no JWT_SECRET refuses to sign', () => signSnippetAsset(ORG, 'k/a.pdf'));

    process.env.JWT_SECRET = '   ';
    refuses('a whitespace-only JWT_SECRET is not a secret', () => generateMediaToken(MSG, SESSION, ORG));
  } finally {
    if (previous === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previous;
  }

  check('the real secret still signs after the refusals',
    typeof generateMediaToken(MSG, SESSION, ORG) === 'string');
}

console.log('');
console.log(passed + '/' + (passed + failed) + ' checks passed.');
if (failed > 0) process.exitCode = 1;
