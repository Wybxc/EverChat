import type { AccessIdentity } from '../../shared/auth/types';

let onlineIdentity: AccessIdentity | null = null;
let active = new AbortController();
export const networkIdentity = () => onlineIdentity;
export const authSignal = () => active.signal;
export function authorizeNetwork(identity: AccessIdentity | null) {
  const becameReady = identity && !onlineIdentity;
  onlineIdentity = identity;
  if (!identity) {
    active.abort();
    active = new AbortController();
  }
  if (becameReady && typeof window !== 'undefined')
    window.dispatchEvent(new Event('everchat:network-ready'));
}
export function authFailure(status: number, code?: string) {
  return status === 401 || (status === 403 && code === 'ACCESS_DENIED');
}
export function notifyAuthFailure(status: number, code?: string) {
  if (!authFailure(status, code)) return;
  authorizeNetwork(null);
  if (typeof window !== 'undefined')
    window.dispatchEvent(new CustomEvent('everchat:auth-required', { detail: { status, code } }));
}
const PENDING_LOGOUT = 'everchat-access:pending-logout';
export function pendingLogout() {
  try {
    const value = localStorage.getItem(PENDING_LOGOUT);
    return value === '/cdn-cgi/access/logout' || value === '/__dev/access/logout' ? value : null;
  } catch {
    return null;
  }
}
export function beginSignOut(url: string) {
  try {
    localStorage.setItem(PENDING_LOGOUT, url);
  } catch {
    /* Current tab remains locked. */
  }
}
export function completeSignOut(url: string) {
  try {
    localStorage.removeItem(PENDING_LOGOUT);
  } catch {
    /* Edge logout still proceeds. */
  }
  location.assign(url);
}
export const resumeAccess = () => {
  try {
    localStorage.removeItem(PENDING_LOGOUT);
  } catch {
    /* Explicit login still proceeds. */
  }
  location.assign(
    `/auth/resume?returnTo=${encodeURIComponent(location.pathname + location.search + location.hash)}`,
  );
};
