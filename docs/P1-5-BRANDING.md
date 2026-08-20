# P1.5 Branding

Started: 2026-08-19
Completed checkpoint: 2026-08-19

## Landed

- Frontend security prerequisite is complete: Next.js is 16.3.1 and `npm audit` is clean.
- Browser API/socket calls use same-origin routing through Next rewrites.
- Next 16 `proxy.ts` forwards the request host for presentation-only branding resolution. It does
  not affect JWT scope or backend tenant authority.
- `Organization.tier` stores `FREE|GROWTH|BUSINESS|ENTERPRISE` as a string for entitlement checks.
- `OrganizationBranding` stores per-organization product name, signed local logo/favicon asset URLs,
  primary/accent HSL values, locale, direction, optional custom footer, optional custom domain, and
  custom-domain verification token/status.
- Existing organizations are backfilled with default RabiTech branding.
- New platform-created subscribers receive a branding row during onboarding.
- Public branding lookup is host-based and audited through platform scope.
- Authenticated org admins can read/update their own branding from Settings; non-admin users keep
  receiving 403 from `PATCH /api/branding/current`.
- Platform owners can update a subscriber branding record through
  `PATCH /api/branding/organizations/:organizationId`.
- Branding logo/favicon upload is local-volume backed by the backend. The upload route accepts PNG,
  JPEG, SVG, and WebP only after magic-byte/content validation, caps the body at 2MB, and rejects SVG
  scripts or inline event handlers.
- Public branding assets are served through signed `/api/branding/assets/...` URLs.
- FREE and GROWTH organizations always render `Powered by RabiTech`; API attempts to customize or
  remove the footer on those tiers return 403. BUSINESS and ENTERPRISE may replace or remove it.
- Settings branding controls include bilingual Arabic/English labels, live preview, upload controls,
  color pickers backed by HSL storage, footer entitlement messaging, and domain verification record
  display.
- Dashboard pages render the server-enforced footer attribution.
- Root layout injects branding CSS variables server-side and uses branded metadata/favicon.
- Login no longer ships prefilled credentials.
- Login and sidebar use branded product identity; theme glows/selection/gradients now read CSS
  variables instead of hardcoded violet utilities.
- Remaining violet/purple grep hits are intentional defaults (`DEFAULT_BRANDING`, `globals.css`, and
  the color-picker fallback). Tenant runtime values override those variables server-side.

## Custom Domain Operations

Code support exists for validation, uniqueness, verification token generation, and status display.
DNS/TLS/proxying is intentionally not automated in P1.5.

1. Set the subscriber custom domain in Settings or via the platform owner branding API.
2. Copy the generated TXT value: `rabitech-site-verification=<token>`.
3. Ask the customer to publish that TXT record on the requested host.
4. Verify the DNS record outside the app, then mark the row verified operationally by setting
   `OrganizationBranding.customDomainVerifiedAt`.
5. Add the domain to the edge proxy/TLS certificate management for the frontend host.
6. Confirm the request host reaches the frontend and that `/api/branding/public?host=<domain>`
   returns the subscriber branding.

## Verification

- Database backup: `.tools/backups/rabitech-before-p15-20260819-194938.dump`.
- `cd apps/backend && npx prisma migrate deploy`
- `cd apps/backend && npx prisma generate`
- `cd apps/backend && npx tsc --noEmit -p .`
- `cd apps/backend && npm run test:tenancy` -> `38/38 checks passed`
- `cd apps/frontend && npm run build`
- `cd apps/frontend && npm audit --json` -> `0 vulnerabilities`

## Still Open

- Replace remaining product-name mentions inside message templates/campaign copy where they are
  tenant-facing business copy rather than platform labels.
- Add polished platform-console branding controls if platform owners should edit all branding without
  using the owner API.
- Normalize the existing mojibake dashboard strings; new P1.5 labels are bilingual, but the older
  settings page copy still needs a separate encoding cleanup.
