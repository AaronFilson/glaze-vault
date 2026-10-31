import { expect, it } from 'vitest';
import { offered } from './phone';

it('offers a computer everything', () => {
  expect(offered('desktop', false)).toEqual({ import: true, backups: true, team: true, auditLog: true, hosting: true });
  expect(offered('desktop', true).import).toBe(true);
});

it("offers a phone's own vault everything but hosting", () => {
  for (const platform of ['ios', 'android'] as const) {
    expect(offered(platform, false)).toEqual({ import: true, backups: true, team: true, auditLog: true, hosting: false });
  }
});

it('leaves running a vault a phone joined to a computer', () => {
  expect(offered('ios', true)).toEqual({ import: false, backups: false, team: false, auditLog: false, hosting: false });
});
