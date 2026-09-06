/**
 * The names this platform and its gateways use to reach each other across the
 * Docker host boundary.
 *
 * There are exactly three, and they must agree. They lived in four places with
 * two different answers until 2026-09-06, which is how the odd one out went
 * unnoticed:
 *
 *   - `hostAccessName()`     — how this process dials a tenant gateway's
 *                              published port.
 *   - `gatewayBackendHost()` — the host recorded in a channel's `baseUrl`, i.e.
 *                              how the platform will reach that gateway later.
 *   - `webhookBaseUrl()`     — how a gateway container reaches this backend.
 *
 * **The rule: the host is `host.docker.internal`.** Every compose file in this
 * repository maps it with `extra_hosts: "host.docker.internal:host-gateway"`,
 * so the name resolves on a Linux host and not only on Docker Desktop. The
 * mapping is what makes the rule safe to apply everywhere; without it the name
 * is a Desktop convenience.
 *
 * The one that was wrong was `webhookBaseUrl`, defaulted to `backend.local` —
 * an alias on the *main* compose network. It works for the shared development
 * gateway, which sits on that network. It cannot work for a per-tenant gateway,
 * which runs in its own compose project on its own network and cannot resolve
 * the alias at all. The failure is invisible from here: registering the webhook
 * succeeds, and only delivery fails, inside a container nobody reads. See D-14.
 *
 * Two further constraints on any value chosen here, both enforced by the
 * gateway rather than by us: its URL validator rejects single-label hosts
 * (`backend`), and its SSRF guard rejects a host resolving to a private address
 * unless that host is named in `SSRF_ALLOWED_HOSTS`.
 */

/** Default host for every name below. See the rule above. */
const HOST_GATEWAY = 'host.docker.internal';

/**
 * How this process reaches a tenant gateway's published port.
 *
 * The default was `127.0.0.1` while the provisioning worker ran on the host. It
 * now runs as a compose service, where `127.0.0.1` is the worker container
 * itself — every readiness probe would dial itself and time out. Set
 * `GATEWAY_HOST_ACCESS=127.0.0.1` to run the worker on the host again.
 */
export function hostAccessName(): string {
  return process.env.GATEWAY_HOST_ACCESS || HOST_GATEWAY;
}

/** The host recorded in a newly provisioned channel's `baseUrl`. */
export function gatewayBackendHost(): string {
  return process.env.GATEWAY_BACKEND_HOST || HOST_GATEWAY;
}

/**
 * Base URL a gateway container uses to reach this backend.
 *
 * This is the *gateway's* view of us, not a public URL.
 */
export function webhookBaseUrl(): string {
  return (process.env.BACKEND_INTERNAL_URL || `http://${HOST_GATEWAY}:4000`).replace(/\/$/, '');
}
