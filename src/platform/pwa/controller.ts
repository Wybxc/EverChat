import { flushStorage } from '../storage';
import { notifyAuthFailure } from '../auth';
import {
  diagnosePwaFailure,
  pwaFailureMessage,
  safePwaError,
  type PwaDiagnostic,
  type PwaFailure,
  type PwaPhase,
  type PwaSource,
} from './diagnostics';
import { reloadBlocked } from './reload-guard';
import { freezeForReload } from './browser-lock';
import {
  APP_VERSION,
  PWA_CHANNEL,
  type Preparation,
  type ReloadReason,
  type ReloadCommand,
} from './protocol';
import { isBundledAsset } from './assets';

type InstallPrompt = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};
type PwaState = {
  supported: boolean;
  ready: boolean;
  checking: boolean;
  pending: boolean;
  repairing: boolean;
  noticeError: boolean;
  diagnostic?: PwaDiagnostic;
  available: boolean;
  preparing: boolean;
  installing: boolean;
  canInstall: boolean;
  installed: boolean;
  error: ReloadReason | '';
  resourceError: boolean;
  version: string;
};
let state: PwaState = {
  supported:
    typeof navigator !== 'undefined' && 'serviceWorker' in navigator && import.meta.env.PROD,
  ready: false,
  checking: false,
  pending: false,
  repairing: false,
  noticeError: false,
  available: false,
  preparing: false,
  installing: false,
  canInstall: false,
  installed: false,
  error: '',
  resourceError: false,
  version: APP_VERSION,
};
const listeners = new Set<() => void>();
const publish = (patch: Partial<PwaState>) => {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
};
export const subscribePwa = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const pwaSnapshot = () => state;
let registration: ServiceWorkerRegistration | undefined;
let registering: Promise<ServiceWorkerRegistration> | undefined;
let checking: Promise<void> | undefined;
let checkId = 0;
let failureCount = 0;
const watched = new WeakSet<ServiceWorkerRegistration>();
const sources = new WeakMap<ServiceWorkerRegistration, PwaSource>();
let installPrompt: InstallPrompt | undefined;
let preparedToken: string | undefined;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;
let reloading = false;
let changing = false;
let controllerScript: string | undefined;
let started = false;
let lastCheck = 0;
let initialControlAt: number | undefined;
const earlyAssets = new Set<string>();
function cacheEarlyResources(worker: ServiceWorker, entries: PerformanceEntry[]) {
  const urls = entries
    .map(({ name }) => name)
    .filter((url) => {
      if (!isBundledAsset(new URL(url), location.origin) || earlyAssets.has(url)) return false;
      earlyAssets.add(url);
      return true;
    });
  if (urls.length) worker.postMessage({ channel: PWA_CHANNEL, type: 'cache-used', urls });
}
function diagnostic(source: PwaSource, phase: PwaPhase, failure?: PwaFailure, error?: unknown) {
  publish({
    diagnostic: {
      at: new Date().toISOString(),
      source,
      phase,
      pageVersion: APP_VERSION,
      workerVersion: state.diagnostic?.workerVersion,
      failure,
      ...(error ? { summary: safePwaError(error) } : {}),
    },
  });
}
async function failed(source: PwaSource, phase: PwaPhase, error: unknown, id = checkId) {
  const failure = !navigator.onLine
    ? 'offline'
    : source === 'manual'
      ? await diagnosePwaFailure()
      : 'unknown';
  if (id !== checkId || state.available) return;
  failureCount++;
  diagnostic(source, phase, failure, error);
  publish({ error: pwaFailureMessage(failure), noticeError: source === 'manual' });
  if (failure === 'authentication') notifyAuthFailure(401);
}

function release(token?: string) {
  if (token && preparedToken !== token) return;
  preparedToken = undefined;
  clearTimeout(releaseTimer);
  freezeForReload(false);
  publish({ preparing: false });
}
async function prepare(token: string): Promise<Preparation> {
  if (preparedToken)
    return preparedToken === token ? { ready: true } : { ready: false, reason: 'otherUpdate' };
  const reason = reloadBlocked();
  if (reason) return { ready: false, reason };
  preparedToken = token;
  freezeForReload(true);
  publish({ preparing: true, error: '', noticeError: false });
  releaseTimer = setTimeout(() => {
    release(token);
    publish({ error: 'waitTimeout', noticeError: true });
  }, 20_000);
  try {
    window.dispatchEvent(new Event('everchat:prepare-reload'));
    await flushStorage();
    if (preparedToken !== token) return { ready: false, reason: 'updateCancelled' };
    const after = reloadBlocked();
    if (after) {
      release(token);
      return { ready: false, reason: after };
    }
    return { ready: true };
  } catch {
    release(token);
    return { ready: false, reason: 'storageFailed' };
  }
}
function request<T>(worker: ServiceWorker, type: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error('serviceTimeout'));
    }, 20_000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(event.data as T);
    };
    worker.postMessage({ channel: PWA_CHANNEL, type }, [channel.port2]);
  });
}
async function controllerChanged() {
  const worker = navigator.serviceWorker.controller;
  if (!worker) return;
  if (!controllerScript) {
    initialControlAt = performance.now();
    cacheEarlyResources(worker, performance.getEntriesByType('resource'));
  }
  const freshRepair =
    worker.scriptURL !== controllerScript && new URL(worker.scriptURL).searchParams.has('repair');
  controllerScript = worker.scriptURL;
  try {
    const { version } = await request<{ version: string }>(worker, 'version');
    if (state.diagnostic) publish({ diagnostic: { ...state.diagnostic, workerVersion: version } });
    if (version === APP_VERSION && !freshRepair) {
      release();
      publish({ ready: true });
      return;
    }
    const result = await prepare(preparedToken ?? crypto.randomUUID());
    if (result.ready && !reloading) {
      reloading = true;
      location.reload();
    } else if (!result.ready) publish({ error: result.reason ?? 'finishChanges', available: true });
  } catch {
    release();
    publish({ error: 'unknownVersion' });
  }
}
function watch(next: ServiceWorkerRegistration, source: PwaSource) {
  registration = next;
  sources.set(next, source);
  publish({ ready: Boolean(next.active), available: Boolean(next.waiting) });
  if (watched.has(next)) return;
  watched.add(next);
  if (next.active) {
    const active = next.active;
    void request<{ version: string }>(active, 'version')
      .then(({ version }) => {
        if (registration === next && next.active === active && state.diagnostic)
          publish({ diagnostic: { ...state.diagnostic, workerVersion: version } });
      })
      .catch(() => {
        /* Diagnosis never blocks an update. */
      });
  }
  const observe = () => {
    const installing = next.installing;
    if (!installing) return;
    const repairInstall = state.repairing;
    diagnostic(sources.get(next) ?? 'background', 'install');
    publish({ installing: true, checking: false, error: '', noticeError: false });
    const changed = () => {
      if (registration !== next) return;
      if (installing.state === 'installed' || installing.state === 'activated') {
        failureCount = 0;
        publish({
          installing: false,
          ready: Boolean(next.active) || installing.state === 'activated',
          available: Boolean(next.waiting),
          error: '',
          noticeError: false,
        });
      }
      if (installing.state === 'redundant') {
        // Browsers remove an unsuccessful first install. Never retain that dead object.
        if (!next.active && !next.waiting) registration = undefined;
        const origin = sources.get(next) ?? 'background';
        failureCount++;
        diagnostic(origin, 'install', 'install');
        publish({
          installing: false,
          error: repairInstall ? 'repairDownloadFailed' : pwaFailureMessage('install'),
          noticeError: origin === 'manual',
        });
      }
    };
    installing.addEventListener('statechange', changed);
    changed();
  };
  next.addEventListener('updatefound', observe);
  observe();
}
async function currentRegistration(source: PwaSource) {
  if (registering) return registering;
  registering = (async () => {
    const existing = await navigator.serviceWorker.getRegistration('/');
    const next =
      existing && (existing.active || existing.waiting || existing.installing)
        ? existing
        : await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    watch(next, source);
    return next;
  })().finally(() => {
    registering = undefined;
  });
  return registering;
}
export async function registerPwa() {
  if (!state.supported || !navigator.onLine) return;
  diagnostic('background', 'register');
  try {
    await currentRegistration('background');
  } catch (error) {
    await failed('background', 'register', error);
  }
}
export function startPwa() {
  if (started || typeof window === 'undefined') return;
  started = true;
  const installed = () =>
    publish({
      installed:
        matchMedia('(display-mode: standalone)').matches ||
        Boolean((navigator as Navigator & { standalone?: boolean }).standalone),
    });
  installed();
  matchMedia('(display-mode: standalone)').addEventListener('change', installed);
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event as InstallPrompt;
    publish({ canInstall: true });
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = undefined;
    publish({ installed: true, canInstall: false });
  });
  window.addEventListener('vite:preloadError', () => {
    // A module never used online is intentionally absent from the offline cache.
    // Markdown keeps a readable fallback and retries when connectivity returns.
    if (navigator.onLine)
      publish({
        resourceError: true,
        error: 'resourcesFailed',
        noticeError: true,
      });
  });
  if (!state.supported) return;
  controllerScript = navigator.serviceWorker.controller?.scriptURL;
  if (
    !controllerScript &&
    typeof PerformanceObserver !== 'undefined' &&
    PerformanceObserver.supportedEntryTypes.includes('resource')
  ) {
    // A request can start before control and finish afterwards. Observe those late
    // completions as well; requests started under SW control already cache normally.
    const observer = new PerformanceObserver((list) => {
      const worker = navigator.serviceWorker.controller;
      const controlledAt = initialControlAt;
      if (worker && controlledAt !== undefined)
        cacheEarlyResources(
          worker,
          list.getEntries().filter(({ startTime }) => startTime < controlledAt),
        );
    });
    observer.observe({ type: 'resource', buffered: true });
  }
  navigator.serviceWorker.addEventListener('controllerchange', () => void controllerChanged());
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.channel !== PWA_CHANNEL) return;
    if (event.data.type === 'prepare')
      void prepare(event.data.token).then((result) => event.ports[0]?.postMessage(result));
    if (event.data.type === 'release') release(event.data.token);
    if (event.data.type === 'reload' && event.data.token === preparedToken && !reloading) {
      reloading = true;
      location.reload();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (
      document.visibilityState === 'visible' &&
      Date.now() - lastCheck > Math.min(300_000 * 2 ** failureCount, 3_600_000)
    )
      void checkPwaUpdate('background');
  });
  window.addEventListener('online', () => void checkPwaUpdate('background'));
  window.addEventListener('everchat:network-ready', () => void checkPwaUpdate('background'));
  if (document.readyState === 'complete') void registerPwa();
  else window.addEventListener('load', () => void registerPwa(), { once: true });
}
export async function checkPwaUpdate(source: PwaSource = 'manual') {
  if (!state.supported || state.preparing || state.installing) return;
  if (checking) return checking;
  if (!navigator.onLine) {
    if (source === 'manual') {
      diagnostic(source, 'check', 'offline');
      publish({ error: pwaFailureMessage('offline'), noticeError: true });
    }
    return;
  }
  const id = ++checkId;
  let timedOut = false;
  publish({ checking: true, pending: true, error: '', noticeError: false });
  lastCheck = Date.now();
  diagnostic(source, 'check');
  const timer = setTimeout(() => {
    timedOut = true;
    if (id !== checkId || state.available || state.installing) return;
    diagnostic(source, 'check', 'timeout');
    publish({
      checking: false,
      error: pwaFailureMessage('timeout'),
      noticeError: source === 'manual',
    });
  }, 15_000);
  checking = (async () => {
    let phase: PwaPhase = 'register';
    try {
      let next = await currentRegistration(source);
      // A register/update job already owns this installation. Another update would
      // queue behind its resource downloads and turn that wait into a false check timeout.
      if (next.installing) return;
      phase = 'check';
      try {
        await next.update();
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'InvalidStateError') throw error;
        registration = undefined;
        next = await currentRegistration(source);
        if (next.installing) return;
        await next.update(); // One recovery attempt; never loop on a broken installation.
      }
      if (id !== checkId) return;
      failureCount = 0;
      publish({
        available: Boolean(next.waiting),
        ready: Boolean(next.active),
        ...(!state.installing && state.diagnostic?.failure !== 'install'
          ? { error: '', noticeError: false }
          : {}),
      });
    } catch (error) {
      if (!timedOut) await failed(source, phase, error, id);
    } finally {
      clearTimeout(timer);
      checking = undefined;
      if (id === checkId) publish({ checking: false, pending: false });
    }
  })();
  return checking;
}
export async function installPwa() {
  const prompt = installPrompt;
  if (!prompt) return;
  installPrompt = undefined;
  publish({ canInstall: false });
  try {
    await prompt.prompt();
    await prompt.userChoice;
  } catch {
    publish({ error: 'installFailed', noticeError: true });
  }
}
export async function applyPwaChange(command: ReloadCommand): Promise<void> {
  if (!state.supported) return recoverApplicationResources();
  if (state.preparing || changing || (command === 'repair' && state.pending)) return;
  changing = true;
  publish({ error: '', noticeError: false });
  try {
    let worker = registration?.waiting;
    if (command === 'repair') {
      if (!navigator.onLine) {
        publish({ error: pwaFailureMessage('offline'), noticeError: true });
        return;
      }
      publish({ repairing: true });
      // A changed script URL forces installation even when the release bytes are unchanged.
      // A distinct cache generation leaves the active version intact until activation.
      const next = await navigator.serviceWorker.register(`/sw.js?repair=${crypto.randomUUID()}`, {
        scope: '/',
        updateViaCache: 'none',
      });
      watch(next, 'manual');
      worker = await installedWorker(next);
    }
    if (!worker) {
      publish({ error: 'serviceNotReady', noticeError: true });
      return;
    }
    const result = await request<Preparation>(worker, command);
    if (!result.ready) publish({ error: result.reason ?? 'updateUnavailable', noticeError: true });
  } catch (error) {
    release();
    publish({
      error: 'updateFailed',
      noticeError: true,
    });
  } finally {
    changing = false;
    publish({ repairing: false });
  }
}

function installedWorker(next: ServiceWorkerRegistration): Promise<ServiceWorker> {
  const worker = next.installing ?? next.waiting;
  if (!worker) return Promise.reject(new Error('repairNotReady'));
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      worker.removeEventListener('statechange', changed);
      if (error) reject(error);
      else resolve(worker);
    };
    const changed = () => {
      if (worker.state === 'installed' || worker.state === 'activated') finish();
      if (worker.state === 'redundant') finish(new Error('repairDownloadFailed'));
    };
    const timer = setTimeout(() => finish(new Error('repairSlow')), 120_000);
    worker.addEventListener('statechange', changed);
    changed();
  });
}
export function dismissPwaError() {
  publish({ error: '', noticeError: false, resourceError: false });
}

/** React.lazy can only retry a rejected chunk in a fresh page runtime. */
export async function recoverApplicationResources(): Promise<void> {
  if (registration?.active) return applyPwaChange('repair');
  const result = await prepare(crypto.randomUUID());
  if (result.ready && !reloading) {
    reloading = true;
    location.reload();
  } else if (!result.ready) publish({ error: result.reason ?? 'finishCurrent' });
}
