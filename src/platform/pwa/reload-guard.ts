const blockers = new Map<object, string | (() => string | null)>();
const writes = new Map<string, number>();
const unknownWrites = new Set<string>();
let locked = false;

export function setReloadBlocker(owner: object, reason: string | (() => string | null) | null) {
  if (reason) blockers.set(owner, reason);
  else blockers.delete(owner);
}
export function reloadBlocked() {
  for (const reason of blockers.values()) {
    const value = typeof reason === 'function' ? reason() : reason;
    if (value) return value;
  }
  if (writes.size) return '云端修改尚未完成';
  if (unknownWrites.size) return '有修改结果尚未确认，请同步或重试后再更新';
  return '';
}
export function beginWrite(key: string) {
  if (locked) throw new Error('应用正在更新，请稍后重试。');
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
