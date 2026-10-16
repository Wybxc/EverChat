import { flushStorage } from '../storage';
import { reloadBlocked } from './reload-guard';
import { freezeForReload } from './browser-lock';
import { APP_VERSION, PWA_CHANNEL, type Preparation, type ReloadCommand } from './protocol';

type InstallPrompt = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};
type PwaState = {
  supported: boolean;
  ready: boolean;
  checking: boolean;
  available: boolean;
  preparing: boolean;
  installing: boolean;
  canInstall: boolean;
  installed: boolean;
  error: string;
  resourceError: boolean;
  version: string;
};
let state: PwaState = {
  supported:
    typeof navigator !== 'undefined' && 'serviceWorker' in navigator && import.meta.env.PROD,
  ready: false,
  checking: false,
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
let registering: Promise<void> | undefined;
let installPrompt: InstallPrompt | undefined;
let preparedToken: string | undefined;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;
let reloading = false;
let started = false;
let lastCheck = 0;

function release(token?: string) {
  if (token && preparedToken !== token) return;
  preparedToken = undefined;
  clearTimeout(releaseTimer);
  freezeForReload(false);
  publish({ preparing: false });
}
async function prepare(token: string): Promise<Preparation> {
  if (preparedToken)
    return preparedToken === token
      ? { ready: true }
      : { ready: false, reason: '另一次更新正在进行' };
  const reason = reloadBlocked();
  if (reason) return { ready: false, reason };
  preparedToken = token;
  freezeForReload(true);
  publish({ preparing: true, error: '' });
  releaseTimer = setTimeout(() => {
    release(token);
    publish({ error: '更新等待超时，请重试。' });
  }, 20_000);
  try {
    window.dispatchEvent(new Event('everchat:prepare-reload'));
    await flushStorage();
    if (preparedToken !== token) return { ready: false, reason: '更新已取消，请重试' };
    const after = reloadBlocked();
    if (after) {
      release(token);
      return { ready: false, reason: after };
    }
    return { ready: true };
  } catch {
    release(token);
    return { ready: false, reason: '无法保存本地记录，请释放浏览器存储后重试' };
  }
}
function request<T>(worker: ServiceWorker, type: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error('应用服务未响应，请重试。'));
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
  try {
    const { version } = await request<{ version: string }>(worker, 'version');
    if (version === APP_VERSION) {
      release();
      publish({ ready: true });
      return;
    }
    const result = await prepare(preparedToken ?? crypto.randomUUID());
    if (result.ready && !reloading) {
      reloading = true;
      location.reload();
    } else if (!result.ready)
      publish({ error: result.reason ?? '完成当前修改后再更新。', available: true });
  } catch {
    release();
    publish({ error: '无法确认应用版本，请检查更新。' });
  }
}
function watch(next: ServiceWorkerRegistration) {
  registration = next;
  publish({ ready: Boolean(next.active), available: Boolean(next.waiting), error: '' });
  const observe = () => {
    const installing = next.installing;
    if (!installing) return;
    publish({ installing: true });
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed')
        publish({
          installing: false,
          ready: Boolean(next.active),
          available: Boolean(next.waiting),
        });
      if (installing.state === 'activated') publish({ installing: false, ready: true });
      if (installing.state === 'redundant')
        publish({ installing: false, error: '离线资源未能准备，请检查更新或修复缓存。' });
    });
  };
  next.addEventListener('updatefound', observe);
  observe();
}
export async function registerPwa() {
  if (!state.supported) return;
  if (registering) return registering;
  registering = (async () => {
    try {
      watch(
        await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }),
      );
    } catch {
      publish({ error: '离线服务注册失败，请重试。' });
    }
  })().finally(() => {
    registering = undefined;
  });
  return registering;
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
  window.addEventListener('vite:preloadError', () =>
    publish({ resourceError: true, error: '界面资源未能加载，请修复缓存后重试。' }),
  );
  if (!state.supported) return;
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
    if (document.visibilityState === 'visible' && Date.now() - lastCheck > 300_000)
      void checkPwaUpdate();
  });
  window.addEventListener('online', () => void checkPwaUpdate());
  if (document.readyState === 'complete') void registerPwa();
  else window.addEventListener('load', () => void registerPwa(), { once: true });
}
export async function checkPwaUpdate() {
  if (!state.supported || state.checking || state.preparing) return;
  publish({ checking: true, error: '' });
  lastCheck = Date.now();
  try {
    if (!registration) await registerPwa();
    if (!registration) return;
    await registration.update();
    publish({ available: Boolean(registration.waiting), ready: Boolean(registration.active) });
  } catch {
    publish({ error: '更新检查失败，请恢复连接后重试。' });
  } finally {
    publish({ checking: false });
  }
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
    publish({ error: '安装未能完成，可从浏览器菜单安装。' });
  }
}
export async function applyPwaChange(command: ReloadCommand) {
  if (state.preparing) return;
  publish({ error: '' });
  try {
    const worker = command === 'update' ? registration?.waiting : registration?.active;
    if (!worker) {
      publish({ error: '应用服务尚未就绪，请先检查更新。' });
      return;
    }
    const result = await request<Preparation>(worker, command);
    if (!result.ready) publish({ error: result.reason ?? '更新暂时无法进行。' });
  } catch (error) {
    release();
    publish({ error: error instanceof Error ? error.message : '更新未能完成。' });
  }
}
export function dismissPwaError() {
  publish({ error: '', resourceError: false });
}

/** React.lazy can only retry a rejected chunk in a fresh page runtime. */
export async function recoverApplicationResources() {
  if (registration?.active) return applyPwaChange('repair');
  const result = await prepare(crypto.randomUUID());
  if (result.ready && !reloading) {
    reloading = true;
    location.reload();
  } else if (!result.ready) publish({ error: result.reason ?? '请先完成当前修改。' });
}
