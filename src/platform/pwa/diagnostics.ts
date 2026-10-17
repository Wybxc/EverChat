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

export function pwaFailureMessage(failure: PwaFailure) {
  return {
    offline: '当前离线，联网后重试。',
    authentication: '登录已失效，重新登录后检查更新。',
    server: '更新服务暂不可用，请稍后重试。',
    script: '更新文件异常，请稍后重试。',
    install: '离线资源未能准备，请检查更新后重试。',
    timeout: '检查更新耗时较长，浏览器仍在处理。',
    unknown: '暂时无法检查更新，请重试。',
  }[failure];
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
