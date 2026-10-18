import { clearNotificationStorage } from './store';

export async function clearNotificationLocal() {
  await clearNotificationStorage();
  if ('serviceWorker' in navigator) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        navigator.serviceWorker
          .getRegistration('/')
          .then(async (registration) => {
            await registration?.pushManager?.getSubscription().then((sub) => sub?.unsubscribe());
          })
          .catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 3000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
