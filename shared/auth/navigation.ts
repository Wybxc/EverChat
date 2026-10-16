export function authReturnTo(value: string | null, origin: string): string {
  if (!value?.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || /^\/(auth|__dev|cdn-cgi)(\/|$)/.test(url.pathname)) return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}
