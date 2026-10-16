import { useSyncExternalStore } from 'react';

type ThemeMode = 'light' | 'dark' | 'system';
const validMode = (value: string | null): ThemeMode => value === 'light' || value === 'dark' ? value : 'system';
let mode: ThemeMode = 'system';
try { mode = validMode(localStorage.getItem('everchat:theme')); } catch { /* Use the system preference. */ }
const media = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();
function apply() {
  const theme = mode === 'system' ? media.matches ? 'dark' : 'light' : mode;
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#151517' : '#ffffff');
}
apply();
media.addEventListener('change', () => { if (mode === 'system') apply(); });
window.addEventListener('storage', (event) => {
  if (event.key !== 'everchat:theme' && event.key !== null) return;
  mode = validMode(event.newValue); apply();
  for (const listener of listeners) listener();
});
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useThemeMode() {
  const current = useSyncExternalStore(subscribe, () => mode);
  const choose = (value: ThemeMode) => {
    mode = value; apply();
    try { localStorage.setItem('everchat:theme', mode); } catch { /* Keep the session preference. */ }
    for (const listener of listeners) listener();
  };
  return [current, choose] as const;
}
