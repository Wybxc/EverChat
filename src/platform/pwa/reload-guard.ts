import type { ReloadReason } from './protocol';
const blockers = new Map<object, ReloadReason | (() => ReloadReason | null)>();
const writes = new Map<string, number>();
const unknownWrites = new Set<string>();
let locked = false;

export function setReloadBlocker(
  owner: object,
  reason: ReloadReason | (() => ReloadReason | null) | null,
) {
  if (reason) blockers.set(owner, reason);
  else blockers.delete(owner);
}
export function reloadBlocked() {
  for (const reason of blockers.values()) {
    const value = typeof reason === 'function' ? reason() : reason;
    if (value) return value;
  }
  if (writes.size) return 'cloudWrites';
  if (unknownWrites.size) return 'unconfirmedWrites';
  return '';
}
export function beginWrite(key: string) {
  if (locked) throw new Error('Application is updating. Try again shortly.');
  writes.set(key, (writes.get(key) ?? 0) + 1);
  let finished = false;
  return (confirmed: boolean) => {
    if (finished) return;
    finished = true;
    const remaining = (writes.get(key) ?? 1) - 1;
    if (remaining) writes.set(key, remaining);
    else writes.delete(key);
    if (confirmed) unknownWrites.delete(key);
    else unknownWrites.add(key);
  };
}
export function setReloadLock(value: boolean) {
  locked = value;
}
