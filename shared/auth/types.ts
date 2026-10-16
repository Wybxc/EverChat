import type { SessionSettings } from '../providers/types';

export interface AccessIdentity {
  issuer: string;
  sub: string;
  email: string;
}
export interface SessionInfo extends SessionSettings {
  authenticated: boolean;
  identity: AccessIdentity;
  logoutUrl: '/cdn-cgi/access/logout' | '/__dev/access/logout';
}
export const identityKey = (identity: AccessIdentity) =>
  JSON.stringify([identity.issuer, identity.sub]);
