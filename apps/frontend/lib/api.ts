import axios from 'axios';
import { getBackendBaseUrl } from './runtime-url';

const api = axios.create({
  baseURL: getBackendBaseUrl(),
});

if (typeof window !== 'undefined') {
  api.interceptors.request.use((config) => {
    config.baseURL = getBackendBaseUrl();
    return config;
  });
}

/**
 * Which subscriber the platform owner is currently viewing. Empty for normal
 * tenant users — the backend ignores this header outside platform scope, so a
 * stale value can never widen a tenant's own access.
 */
export const VIEW_AS_KEY = 'rabitech_view_as_org';
export const VIEW_AS_CHANGED_EVENT = 'rabitech:view-as-changed';

export type ViewAsOrg = {
  id: string;
  name: string;
  accessToken: string;
  expiresAt: string;
};

export function getViewAsOrg(): ViewAsOrg | null {
  if (typeof window === 'undefined') return null;
  try {
    // Retire the old unbounded, cross-tab selection. A platform access grant is
    // scoped to this tab and expires on the server after 15 minutes.
    localStorage.removeItem(VIEW_AS_KEY);
    const raw = sessionStorage.getItem(VIEW_AS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ViewAsOrg>;
    const expiresAt = new Date(String(parsed.expiresAt || '')).getTime();
    if (!parsed.id || !parsed.name || !parsed.accessToken || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      sessionStorage.removeItem(VIEW_AS_KEY);
      return null;
    }
    return parsed as ViewAsOrg;
  } catch {
    try { sessionStorage.removeItem(VIEW_AS_KEY); } catch { /* storage is unavailable */ }
    return null;
  }
}

export function setViewAsOrg(org: ViewAsOrg | null) {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(VIEW_AS_KEY);
  if (org) sessionStorage.setItem(VIEW_AS_KEY, JSON.stringify(org));
  else sessionStorage.removeItem(VIEW_AS_KEY);
  window.dispatchEvent(new Event(VIEW_AS_CHANGED_EVENT));
}

api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('rabitech_token');
    if (token) config.headers.Authorization = `Bearer ${token}`;
    const viewAs = getViewAsOrg();
    const platformEndpoint = String(config.url || '').startsWith('/api/platform');
    if (viewAs && !platformEndpoint) {
      config.headers['X-Organization-Id'] = viewAs.id;
      config.headers['X-Platform-View-Token'] = viewAs.accessToken;
    }
  }
  return config;
});

/**
 * Where a locked-out organization is sent.
 *
 * Keyed on the response *code*, never on the bare 403: a 403 also means "you
 * lack that permission", and sending an agent to the pricing page because
 * they tried to delete a shared view would be nonsense.
 */
const GATE_DESTINATIONS: Record<string, string> = {
  TRIAL_EXPIRED: '/pricing?trial=expired',
  SUBSCRIBER_SUSPENDED: '/pricing?account=suspended',
};

api.interceptors.response.use(
  (res) => res,
  (err) => {
    const platformViewCode = err.response?.status === 403 ? err.response?.data?.code : undefined;
    if (
      typeof window !== 'undefined'
      && ['PLATFORM_VIEW_EXPIRED', 'PLATFORM_VIEW_INVALID', 'PLATFORM_VIEW_AUDIT_MISSING'].includes(platformViewCode)
    ) {
      setViewAsOrg(null);
      if (!window.location.pathname.startsWith('/platform')) {
        window.location.href = '/platform/subscribers?viewAs=expired';
      }
      return Promise.reject(err);
    }
    const gateCode = err.response?.status === 403 ? err.response?.data?.code : undefined;
    const destination = gateCode ? GATE_DESTINATIONS[gateCode] : undefined;
    if (destination && typeof window !== 'undefined') {
      // The session stays valid — they are a real user of an organization that
      // owes money, not someone who has been signed out. Clearing the token
      // here would make them log in again just to reach the checkout.
      const alreadyThere = window.location.pathname === '/pricing';
      if (!alreadyThere) window.location.href = destination;
      return Promise.reject(err);
    }
    if (err.response?.status === 401 && typeof window !== 'undefined') {
      const path = window.location.pathname;
      const isLogin = path === '/login' || err.config?.url?.includes('/api/auth/login');
      if (!isLogin) {
        localStorage.removeItem('rabitech_token');
        localStorage.removeItem('rabitech_user');
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  }
);

export default api;
