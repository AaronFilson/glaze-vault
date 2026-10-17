// What the screens need to know about a team's vault (docs/adr/0012-teams-on-one-computer.md):
// which collection a record is in, what to call it, and whether this person may change it. The
// core decides; these only keep the screens from offering what it would refuse.
import type { Access, Collection, Kind } from './api';

/** A collection's name as the lists show it. Private collections have no name of their own. */
export function collectionLabel(collection: Collection, access: Access, names: Record<string, string>): string {
  if (!collection.owner) return collection.name || 'Shared';
  if (collection.owner === access.me.id) return 'Private';
  return `From ${names[collection.owner] ?? 'someone'}`;
}

/** Whether this person may change records of a kind in a collection. Always, in a one-person
 * vault. */
export function canEdit(access: Access | null, collectionId: string | null | undefined, kind: Kind = 'recipe'): boolean {
  if (!access?.team) return true;
  const collection = access.collections.find((c) => c.id === collectionId);
  return !!collection && collection.changes.includes(kind);
}

/** The collections new records of a kind can go into. */
export function editableCollections(access: Access | null, kind: Kind = 'recipe'): Collection[] {
  return (access?.collections ?? []).filter((c) => c.changes.includes(kind));
}

/** Where a new record goes unless the person chooses: the first shared collection they may change,
 * else their private one. */
export function defaultCollection(access: Access | null): string | null {
  if (!access?.team) return null;
  const editable = editableCollections(access);
  return (editable.find((c) => !c.owner) ?? editable.find((c) => c.owner === access.me.id) ?? editable[0])?.id ?? null;
}

/** Records grouped by collection, in the order of the person's collections, for the lists. */
export function byCollection<Item extends { collectionId?: string }>(
  items: Item[],
  access: Access,
  names: Record<string, string>
): { label: string; items: Item[] }[] {
  return access.collections
    .map((collection) => ({
      label: collectionLabel(collection, access, names),
      items: items.filter((item) => item.collectionId === collection.id)
    }))
    .filter((group) => group.items.length > 0);
}

/** Whether someone may only weigh batches in every shared collection they have: they start on
 * the batch sheets. */
export function onlyWeighs(access: Access | null): boolean {
  const shared = (access?.collections ?? []).filter((c) => !c.owner);
  return !!access?.team && shared.length > 0 && shared.every((c) => c.role === 'operator');
}
