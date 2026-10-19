import { getLocaleSnapshot, subscribeLocale } from '../i18n/preference';
import { writeNotificationLocale } from './store';

let pending = Promise.resolve();
const mirror = () => {
  const { preference } = getLocaleSnapshot();
  pending = pending.then(() => writeNotificationLocale(preference)).catch(() => {});
};
let started = false;
/** Private runtime only. This never requests permission or renews a subscription. */
export function mirrorNotificationLocale() {
  if (!started) {
    started = true;
    subscribeLocale(mirror);
  }
  mirror();
}
