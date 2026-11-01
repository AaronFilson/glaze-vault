import type { Platform } from './api';

/** What the open vault offers on this platform (docs/adr/0031-phone-screens.md, plan section 2.4).
 * Roles still decide what a person may do; this only decides what a phone shows. A phone's own vault
 * gets everything but hosting; a phone that joined a host leaves running the vault to a computer. */
export interface Offered {
  import: boolean;
  backups: boolean;
  team: boolean;
  auditLog: boolean;
  hosting: boolean;
}

export function offered(platform: Platform, replica: boolean): Offered {
  if (platform === 'desktop') return { import: true, backups: true, team: true, auditLog: true, hosting: true };
  return { import: !replica, backups: !replica, team: !replica, auditLog: !replica, hosting: false };
}

/** The views the phone's bottom bar leads to; the rest are under More. */
export const PHONE_TABS = ['recipes', 'mixes', 'firings'] as const;
