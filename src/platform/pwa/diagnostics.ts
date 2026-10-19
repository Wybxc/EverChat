export type PwaSource = 'manual' | 'background';
export type PwaPhase = 'register' | 'check' | 'install';
export type PwaFailure =
  'offline' | 'authentication' | 'server' | 'script' | 'install' | 'timeout' | 'unknown';
export type PwaDiagnostic = {
  at: string;
  source: PwaSource;
  phase: PwaPhase;
  pageVersion: string;
  workerVersion?: string;
  failure?: PwaFailure;
  summary?: string;
};

/** Never retain URLs, response bodies or credentials in copyable diagnostics. */
export function safePwaError(error: unknown) {
  if (!(error instanceof Error)) return 'Unknown error';
  return `${error.name}: ${error.message}`
    .replace(/https?:\/\/[^\s'"<>)]*/gi, '[URL]')
    .replace(/(?:sk-|eyJ)[\w.\-]+/g, '[credential]')
    .replace(/(?:authorization|cookie|token|api[_-]?key)\s*[:=]\s*\S+/gi, '[credential]')
    .slice(0, 400);
}

export function pwaFailureMessage(failure: PwaFailure): import('./protocol').ReloadReason {
  return (
    {
      offline: 'failureOffline',
      authentication: 'failureAuthentication',
      server: 'failureServer',
      script: 'failureScript',
      install: 'failureInstall',
      timeout: 'failureTimeout',
      unknown: 'failureUnknown',
    } as const
  )[failure];
}

/** A failed SW request alone cannot prove that an Access session expired. */
export async function diagnosePwaFailure(fetcher: typeof fetch = fetch): Promise<PwaFailure> {
  if (!navigator.onLine) return 'offline';
  const options: RequestInit = {
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'manual',
    signal: AbortSignal.timeout(4000),
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  };
  try {
    const session = await fetcher('/api/session', options);
    if (session.status === 401) return 'authentication';
    if (
      session.status === 403 &&
      session.headers.get('Content-Type')?.includes('application/json')
    ) {
      const body = (await session.json()) as { code?: string };
      if (body.code === 'ACCESS_DENIED') return 'authentication';
    }
    if (session.status >= 500) return 'server';
    const script = await fetcher('/sw.js', options);
    if (script.status >= 500) return 'server';
    if (script.ok && !/(?:java|ecma)script/i.test(script.headers.get('Content-Type') ?? ''))
      return 'script';
  } catch {
    /* Opaque redirects and network errors remain uncertain. */
  }
  return 'unknown';
}
