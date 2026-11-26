import { useEffect, useId, useState } from 'react';
import type { Capabilities, CustomRole, Kind, Role } from '../api';

export const ROLES: { role: Role | ''; label: string }[] = [
  { role: '', label: 'No access' },
  { role: 'operator', label: 'Batch operator: weighs' },
  { role: 'chemist', label: 'Chemist: reads' },
  { role: 'tester', label: 'Tester: logs firings' },
  { role: 'formulator', label: 'Formulator: changes' }
];

/** What a role an admin makes can be allowed to change, in the order shown. */
export const CHANGEABLE: { kind: Kind; label: string }[] = [
  { kind: 'recipe', label: 'Recipes' },
  { kind: 'material', label: 'Materials' },
  { kind: 'batch', label: 'Batch sheets' },
  { kind: 'firing', label: 'Firings' },
  { kind: 'mix', label: 'Mixes' },
  { kind: 'limits', label: 'Limit formulas' },
  { kind: 'prices', label: 'Prices' }
];

/** What else a role admins make may do, in the order shown. Managing and every kind but firings
 * need chemistry. */
const CAPABILITIES: { key: keyof Capabilities; label: string }[] = [
  { key: 'chemistry', label: 'Reads recipes’ chemistry' },
  { key: 'export', label: 'Exports' },
  { key: 'print', label: 'Prints' },
  { key: 'manage', label: 'Manages people on its collections' }
];

/** What a new role may do until the admin changes it: as the built-in roles do. */
const NEW_ROLE_MAY: Capabilities = { export: true, print: true, chemistry: true, manage: false };

const mayOf = (role: CustomRole): Capabilities => ({
  export: role.export,
  print: role.print,
  chemistry: role.chemistry,
  manage: role.manage
});

/** "Costing: changes prices", "Reviewer: reads", "Sales: changes firings, without chemistry". */
export function customLabel(role: CustomRole): string {
  const kinds = CHANGEABLE.filter((c) => role.changes.includes(c.kind)).map((c) => c.label.toLowerCase());
  const also = [!role.chemistry && 'without chemistry', role.manage && 'manages'].filter(Boolean);
  return `${role.name}: ${kinds.length ? `changes ${kinds.join(', ')}` : 'reads'}${also.length ? `, ${also.join(', ')}` : ''}`;
}

/** Every role but an admin's, with the admin's own ones, for choosing one. */
export function roleChoices(custom: CustomRole[]): { role: Role; label: string }[] {
  return [
    ...ROLES.filter((r): r is { role: Role; label: string } => r.role !== ''),
    ...custom.map((r) => ({ role: `role:${r.id}` as Role, label: customLabel(r) }))
  ];
}

/** A role an admin made, to rename or change, or a new one to make. */
export function RoleEditor({
  role,
  busy,
  onSave,
  onDelete
}: {
  role: CustomRole | null;
  busy: boolean;
  onSave: (name: string, changes: Kind[], may: Capabilities) => Promise<boolean>;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(role?.name ?? '');
  const [changes, setChanges] = useState<Kind[]>(role?.changes ?? []);
  const [may, setMay] = useState<Capabilities>(role ? mayOf(role) : NEW_ROLE_MAY);
  const id = useId();
  const changed =
    !role ||
    name.trim() !== role.name ||
    changes.length !== role.changes.length ||
    changes.some((k) => !role.changes.includes(k)) ||
    CAPABILITIES.some(({ key }) => may[key] !== role[key]);
  /** Without chemistry, a role changes nothing but firings, and manages nothing. */
  const allowed = (kind: Kind) => may.chemistry || kind === 'firing';
  const setCapability = (key: keyof Capabilities, on: boolean) => {
    const next = { ...may, [key]: on };
    if (!next.chemistry) {
      next.manage = false;
      setChanges(changes.filter((k) => k === 'firing'));
    }
    setMay(next);
  };
  return (
    <li>
      <form
        className="role-editor"
        onSubmit={(e) => {
          e.preventDefault();
          void onSave(name.trim(), changes, may).then((done) => {
            if (done && !role) {
              setName('');
              setChanges([]);
              setMay(NEW_ROLE_MAY);
            }
          });
        }}
      >
        <label htmlFor={`${id}-name`}>{role ? 'Role' : 'New role'}</label>
        <input
          id={`${id}-name`}
          value={name}
          placeholder={role ? undefined : 'Such as Costing, or Glaze tester'}
          onChange={(e) => setName(e.target.value)}
        />
        <fieldset className="plain row wrap">
          <legend>Changes</legend>
          {CHANGEABLE.map(({ kind, label }) => (
            <label key={kind} className="check">
              <input
                type="checkbox"
                checked={changes.includes(kind)}
                disabled={!allowed(kind)}
                onChange={(e) => setChanges(e.target.checked ? [...changes, kind] : changes.filter((k) => k !== kind))}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <fieldset className="plain row wrap">
          <legend>May</legend>
          {CAPABILITIES.map(({ key, label }) => (
            <label key={key} className="check">
              <input
                type="checkbox"
                checked={may[key]}
                disabled={key === 'manage' && !may.chemistry}
                onChange={(e) => setCapability(key, e.target.checked)}
              />
              {label}
            </label>
          ))}
        </fieldset>
        {role && role.chemistry && !may.chemistry && (
          <p className="hint">
            Saving gives each collection this role is on a new key, since its people held the old one.
          </p>
        )}
        <div className="row">
          <button type="submit" disabled={busy || !name.trim() || !changed}>
            {role ? 'Save role' : 'Make role'}
          </button>
          {role && onDelete && (
            <button type="button" className="link danger" disabled={busy} onClick={onDelete}>
              Delete
            </button>
          )}
        </div>
      </form>
    </li>
  );
}

export function CollectionName({
  name,
  busy,
  onRename
}: {
  name: string;
  busy: boolean;
  onRename: (name: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  return (
    <li className="row">
      <label className="visually-hidden" htmlFor={`collection-${name}`}>
        Name of {name}
      </label>
      <input id={`collection-${name}`} value={draft} onChange={(e) => setDraft(e.target.value)} />
      {draft.trim() !== name && (
        <button type="button" disabled={busy || !draft.trim()} onClick={() => void onRename(draft)}>
          Rename
        </button>
      )}
    </li>
  );
}
