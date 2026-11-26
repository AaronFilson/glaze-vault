// Glaze Vault's host for @glazecalc/core (lib/core/host.ts): the catalog's reference tables and
// record readers, extended so a person's own MaterialContent class and data-sheet SG inform its traits.
import type { Host, MaterialClass, Traits } from '@glazecalc/core';
import {
  BODIES,
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

export interface VaultTraitsRecord extends TraitsRecord {
  readonly materialClass?: MaterialClass;
  readonly unclassified?: boolean;
  readonly sheetSg?: number;
}

function traitsOf(record: VaultTraitsRecord | null | undefined): Traits {
  const base = catalogTraitsOf(record);
  const cls = record?.materialClass;
  const sg = record?.sheetSg;
  const density =
    typeof sg === 'number' && Number.isFinite(sg) && sg > 1
      ? { mineral: null, sg }
      : cls
        ? undefined
        : base.density;
  if (!cls && !record?.unclassified && density === base.density) return base;
  return {
    ...base,
    ...(density !== base.density ? { density } : {}),
    ...(record?.unclassified ? { unclassified: true } : {}),
    ...(cls
      ? {
          materialClass: cls,
          calcined: cls === 'grog',
          plasticizer: cls === 'plasticizer',
          ...(cls === 'kaolin' ? { kaolin: true, kaolinOrBallClay: true } : {}),
          ...(cls === 'ball clay' ? { kaolinOrBallClay: true } : {}),
          ...(cls === 'wollastonite' ? { wollastonite: true } : {})
        }
      : {})
  };
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
  bodies: BODIES,
  policy: POLICY
});

export { inWords, worded, wordedWarnings, type WordedWarning };
