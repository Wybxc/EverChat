export const APP_VERSION = import.meta.env.VITE_APP_VERSION as string;
export const STATIC_CACHE_PREFIX = 'everchat-static-';
export const PWA_CHANNEL = 'everchat:pwa';
export type ReloadCommand = 'update' | 'repair';
// Only semantic reasons cross page / Service Worker boundaries.
export type ReloadReason =
  | 'otherUpdate'
  | 'waitTimeout'
  | 'updateCancelled'
  | 'storageFailed'
  | 'serviceTimeout'
  | 'finishChanges'
  | 'unknownVersion'
  | 'repairDownloadFailed'
  | 'resourcesFailed'
  | 'installFailed'
  | 'serviceNotReady'
  | 'updateUnavailable'
  | 'updateFailed'
  | 'repairNotReady'
  | 'repairSlow'
  | 'finishCurrent'
  | 'failureOffline'
  | 'failureAuthentication'
  | 'failureServer'
  | 'failureScript'
  | 'failureInstall'
  | 'failureTimeout'
  | 'failureUnknown'
  | 'cloudWrites'
  | 'unconfirmedWrites'
  | 'unsavedSettings'
  | 'uploadBusy'
  | 'sendBusy'
  | 'backupBusy'
  | 'editBusy'
  | 'otherPageTimeout'
  | 'otherPageNotReady'
  | 'pageChanging'
  | 'workerUpdateFailed'
  | 'finishAddingModel';
export type Preparation = { ready: boolean; reason?: ReloadReason };
