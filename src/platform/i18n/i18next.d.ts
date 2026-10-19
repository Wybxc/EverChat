import 'i18next';
import type common from './locales/en/common';
import type system from './locales/en/system';
import type app from '../../app/locales/en';
import type library from '../../features/library/locales/en';
import type chat from '../../features/chat/locales/en';
import type providers from '../../features/providers/locales/en';

import type presets from '../../features/presets/locales/en';

import type webtools from '../../features/web-tools/locales/en';

import type usage from '../../features/usage/locales/en';

import type attachments from '../../features/attachments/locales/en';

import type sharing from '../../features/sharing/locales/en';

import type backup from '../../features/backup/locales/en';

import type pwa from '../pwa/locales/en';

import type notifications from '../../features/notifications/locales/en';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    returnNull: false;
    enableSelector: true;
    strictKeyChecks: true;
    resources: {
      presets: typeof presets;
      'web-tools': typeof webtools;
      usage: typeof usage;
      attachments: typeof attachments;
      sharing: typeof sharing;
      backup: typeof backup;
      pwa: typeof pwa;
      notifications: typeof notifications;
      common: typeof common;
      system: typeof system;
      app: typeof app;
      library: typeof library;
      chat: typeof chat;
      providers: typeof providers;
    };
  }
}
