import { isSharePage } from '../shared/sharing/types';
import './style.css';
import { startupFailureText } from './platform/i18n/startup';

// Select the public entry before private storage, identity, notifications or PWA startup.
void (
  isSharePage(location.pathname)
    ? import('./features/sharing/PublicShare').then((module) => module.start())
    : import('./private-bootstrap').then((module) => module.start())
).catch(() => {
  const root = document.getElementById('root');
  if (root) root.textContent = startupFailureText();
});
