import { useEffect, useEffectEvent } from 'react';
import { hasOpenModal } from '../components/Modal';

export const macShortcuts = /Mac|iPhone|iPad/.test(navigator.userAgent);
export const commandDefinitions = {
  'new-chat': { label: '开启新对话', key: 'j' },
  'global-search': { label: '全局搜索', key: 'k' },
  'find-in-chat': { label: '搜索当前对话', key: 'f' },
  'focus-composer': { label: '聚焦输入框', key: 'l', shift: true },
  'toggle-sidebar': { label: '切换侧边栏', key: 'b' },
} satisfies Record<string, { label: string; key: string; shift?: boolean }>;
export type CommandId = keyof typeof commandDefinitions;
export const shortcutLabel = (id: CommandId) => {
  const definition = commandDefinitions[id];
  return `${macShortcuts ? '⌘' : 'Ctrl+'}${'shift' in definition ? (macShortcuts ? '⇧' : 'Shift+') : ''}${definition.key.toUpperCase()}`;
};
export const ariaShortcut = (id: CommandId) => {
  const definition = commandDefinitions[id];
  return `${macShortcuts ? 'Meta' : 'Control'}+${'shift' in definition ? 'Shift+' : ''}${definition.key.toUpperCase()}`;
};
type AppCommand = {
  id: CommandId;
  enabled: boolean;
  run: () => void;
  allowModal?: boolean;
  allowEditing?: boolean;
};

/** One listener owns app shortcuts, including their editing and modal scopes. */
export function useAppCommands(commands: AppCommand[]) {
  const handle = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.keyCode === 229 ||
      event.repeat ||
      event.altKey ||
      event.getModifierState('AltGraph') ||
      !(macShortcuts ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
    )
      return;
    const command = commands.find(({ id }) => {
      const definition = commandDefinitions[id];
      const shifted = 'shift' in definition && definition.shift;
      return event.key.toLowerCase() === definition.key && event.shiftKey === shifted;
    });
    const modalOpen =
      hasOpenModal() ||
      Boolean(
        document.querySelector(
          '[data-slot="dialog-content"][data-state="open"], [data-slot="alert-dialog-content"][data-state="open"]',
        ),
      );
    if (!command?.enabled || (modalOpen && !command.allowModal)) return;
    const target = event.target;
    if (target instanceof Element) {
      if (target.closest('[role="menu"]')) return;
      if (!command.allowEditing && target.closest('input, textarea, [contenteditable="true"]'))
        return;
    }
    event.preventDefault();
    command.run();
  });
  useEffect(() => {
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, []);
}
