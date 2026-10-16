import { setReloadLock } from './reload-guard';

let locked = false;
const freezeEvent = (event: Event) => {
  if (!locked) return;
  event.preventDefault();
  event.stopImmediatePropagation();
};
const events = ['beforeinput', 'keydown', 'click', 'submit', 'drop', 'paste'] as const;
export function freezeForReload(value: boolean) {
  if (locked === value) return;
  locked = value;
  setReloadLock(value);
  for (const type of events)
    if (value) window.addEventListener(type, freezeEvent, { capture: true, passive: false });
    else window.removeEventListener(type, freezeEvent, true);
}
