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

export function getViewAsOrg(): { id: string; name: string } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(VIEW_AS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setViewAsOrg(org: { id: string; name: string } | null) {
  if (typeof window === 'undefined') return;
  if (org) localStorage.setItem(VIEW_AS_KEY, JSON.stringify(org));
  else localStorage.removeItem(VIEW_AS_KEY);
}

api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('rabitech_token');
    if (token) config.headers.Authorization = `Bearer ${token}`;
    const viewAs = getViewAsOrg();
    if (viewAs?.id) config.headers['X-Organization-Id'] = viewAs.id;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
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
