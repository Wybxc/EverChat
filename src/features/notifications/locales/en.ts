export default {
  title: 'Answer notifications',
  completion: 'When an answer completes',
  always: 'Always notify',
  never: 'Never notify',
  unfocused: 'Only when unfocused or in background',
  foregroundHint:
    'No alert while an EverChat page on any device signed in to this account is visible and focused.',
  disablePending: 'Disabling pending sync',
  disabled: 'Disabled',
  unsupported: 'Unavailable here. On iPhone or iPad, add EverChat to the home screen.',
  denied: 'Notifications are blocked. Allow them in browser or system settings.',
  notEnabled: 'Not enabled',
  pending: 'Settings pending sync',
  pushReady: 'Background push ready',
  localReady: 'Page notifications available',
  notReady: 'Notifications not ready',
  recheck: 'Check again',
  enable: 'Enable system notifications',
  test: 'Send test notification',
  unsupportedError: 'System notifications are not supported here.',
  registrationNotReady:
    'App notifications are not ready. Wait for the app to finish preparing and try again.',
  settingsFailed: 'Could not configure notifications. Try again.',
  pushFailed:
    'Could not enable background push. Notifications currently require the page to remain online. Try enabling again.',
  localOnly: 'Notifications currently require the page to remain online.',
  signInFirst: 'Reconnect and sign in first.',
  installFirst:
    'Unavailable here. On iPhone or iPad, add EverChat to the home screen, then enable notifications in the app.',
  permissionRequired:
    'Notification permission was not granted. Allow notifications in browser or system settings.',
  enableFirst: 'Enable system notifications first.',
  testTimeout: 'The notification test timed out. Try again.',
  displayFailed: 'Could not display a system notification.',
  invalidSubscription:
    'The browser returned invalid push subscription keys. Enable notifications again.',
} as const;
