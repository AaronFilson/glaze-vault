// Glaze Vault's host for @glazecalc/core (lib/core/host.ts): the catalog's reference tables and
// record readers, extended so a person's own MaterialContent class informs its traits.
import type { Host, Traits } from '@glazecalc/core';
import {
  CONES,
  DENSITIES,
  EXPANSION,
  LIMITS,
  OXIDES,
  POLICY,
  READERS,
  STULL,
  traitsOf as catalogTraitsOf,
  type TraitsRecord
} from '@glazecalc/catalog/host';
import { inWords, worded, wordedWarnings, type WordedWarning } from '@glazecalc/catalog/locale';
import type { MaterialClass } from './materialData';

export interface VaultTraitsRecord extends TraitsRecord {
  readonly materialClass?: MaterialClass;
}

function traitsOf(record: VaultTraitsRecord | null | undefined): Traits {
  const base = catalogTraitsOf(record);
  const cls = record?.materialClass;
  if (!cls) return base;
  if (cls === 'kaolin') return { ...base, kaolin: true, kaolinOrBallClay: true };
  if (cls === 'ball clay') return { ...base, kaolinOrBallClay: true };
  if (cls === 'wollastonite') return { ...base, wollastonite: true };
  return base;
}

export const HOST: Host = Object.freeze({
  ...READERS,
  traitsOf,
  oxides: OXIDES,
  cones: CONES,
  limits: LIMITS,
  stull: STULL,
  densities: DENSITIES,
  expansion: EXPANSION,
  policy: POLICY
});

export { inWords, worded, wordedWarnings, type WordedWarning };
