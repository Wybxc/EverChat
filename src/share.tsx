import './style.css';
import { start } from './features/sharing/PublicShare';
import { showStartupFailure } from './platform/i18n/startup';

try {
  start();
} catch {
  showStartupFailure();
}
