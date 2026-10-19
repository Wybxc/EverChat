import 'i18next';
import type common from './locales/en/common';
import type system from './locales/en/system';
import type app from '../../app/locales/en';
import type library from '../../features/library/locales/en';
import type chat from '../../features/chat/locales/en';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    returnNull: false;
    enableSelector: true;
    strictKeyChecks: true;
    resources: {
      common: typeof common;
      system: typeof system;
      app: typeof app;
      library: typeof library;
      chat: typeof chat;
    };
  }
}
