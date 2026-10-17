import { useEffect, useId, useState } from 'react';
import {
  api,
  errorText,
  MIN_PASSWORD_CHARS,
  type Access,
  type Capabilities,
  type CustomRole,
  type Kind,
  type Role,
  type Team
} from '../api';
import { collectionLabel, editableCollections } from '../team';

/** Where a new recipe or material is saved, in a team's vault. */
export function CollectionPicker({
  access,
  names,
  value,
  onChange,
  kind = 'recipe'
}: {
  access: Access;
  names: Record<string, string>;
  value: string | null;
  onChange: (collection: string) => void;
  /** What is being made, for the collections it can go into. */
  kind?: Kind;
}) {
  const id = useId();
  return (
    <div className="row">
      <label htmlFor={id}>Save in</label>
      <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        {editableCollections(access, kind).map((collection) => (
          <option key={collection.id} value={collection.id}>
            {collectionLabel(collection, access, names)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Below a recipe in a team's vault: moving it, with its firings and batch sheet, to another
 * collection this person may change. Who can see it changes with it, so it is asked first. */
export function MoveTo({
  access,
  names,
  from,
  kinds,
  name,
  along,
  note,
  onMove
}: {
  access: Access;
  names: Record<string, string>;
  /** The collection it is in. */
  from: string;
  /** The kinds of record that move, which this person must be able to change in both. */
  kinds: Kind[];
  name: string;
  /** What goes with it, such as "its 3 firings" and "its batch sheet". */
  along: string[];
  /** What else moving it to a collection, by id and by name, would change, if anything. */
  note?: (to: string, there: string) => string;
  onMove: (to: string) => Promise<void>;
}) {
  const id = useId();
  const others = access.collections.filter((c) => c.id !== from && kinds.every((kind) => c.changes.includes(kind)));
  const [to, setTo] = useState(others[0]?.id ?? '');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!others.length) return null;
  const here = access.collections.find((c) => c.id === from);
  const there = others.find((c) => c.id === to);
  const label = (c: typeof here) => (c ? collectionLabel(c, access, names) : '');
  const move = async () => {
    setBusy(true);
    setError('');
    try {
      await onMove(to);
      setAsking(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="row">
        <label htmlFor={id}>Move to</label>
        <select id={id} value={to} onChange={(e) => setTo(e.target.value)}>
          {others.map((c) => (
            <option key={c.id} value={c.id}>
              {label(c)}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => setAsking(true)}>
          Move…
        </button>
      </div>
      {asking && (
        <div className="notice warning" role="alertdialog" aria-label="Move">
          <p>
            <strong>
              Move {name || 'Untitled'} to {label(there)}?
            </strong>{' '}
            It goes with {inWords(['every revision', ...along])}. People who can open {label(here)} but not{' '}
            {label(there)} will no longer see it.{note && note(to, label(there)) && ` ${note(to, label(there))}`}
          </p>
          <div className="row">
            <button type="button" className="primary" disabled={busy} onClick={() => void move()}>
              {busy ? 'Moving…' : 'Move'}
            </button>
            <button type="button" autoFocus onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </>
  );
}

/** "a", "a and b", "a, b and c". */
const inWords = (items: string[]) =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/** Settings for a one-person vault: growing it into a team's (ADR 12). */
export function ShareVault({ onShared }: { onShared: (organizationWords: string[]) => void }) {
  const [name, setName] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const share = async () => {
    setBusy(true);
    setError('');
    try {
      onShared(await api.growIntoTeam(name));
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <>
      <p>
        Glaze Vault is for one person until you share it. Sharing lets others sign in on this computer with their own
        passwords, and you decide what each of them can see and change. You become its admin.
      </p>
      <label htmlFor="share-name">Your name</label>
      <input id="share-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="As others will see it" />
      <div className="row">
        <button type="button" disabled={!name.trim() || busy} onClick={() => setAsking(true)}>
          Share this vault…
        </button>
      </div>
      {asking && (
        <div className="notice warning" role="alertdialog" aria-label="Share this vault">
          <p>
            Sharing makes an organization recovery key, which opens everything if every admin loses their password and
            recovery sheet. You print it and keep it in a safe next. Your recipes and materials go into a collection
            called Shared, and you get a private one. You can go back to one person later.
          </p>
          <div className="row">
            <button type="button" className="primary" disabled={busy} onClick={share}>
              {busy ? 'Sharing…' : 'Share this vault'}
            </button>
            <button type="button" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="error">{error}</p>}
    </>
  );
}

const ROLES: { role: Role | ''; label: string }[] = [
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
function customLabel(role: CustomRole): string {
  const kinds = CHANGEABLE.filter((c) => role.changes.includes(c.kind)).map((c) => c.label.toLowerCase());
  const also = [!role.chemistry && 'without chemistry', role.manage && 'manages'].filter(Boolean);
  return `${role.name}: ${kinds.length ? `changes ${kinds.join(', ')}` : 'reads'}${also.length ? `, ${also.join(', ')}` : ''}`;
}

/** Settings for a team's admin: people, what each may do in each collection, and collections. */
export function People({
  access,
  onChanged,
  onShrunk,
  onOrganizationKey
}: {
  access: Access;
  onChanged: () => void;
  /** The vault is one person's again; with where the backup made first is. */
  onShrunk: (backup: string) => void;
  /** The organization has a new recovery key, to print: after admin is taken away, or for a lost sheet. */
  onOrganizationKey: (words: string[]) => void;
}) {
  const [shrinking, setShrinking] = useState(false);
  const [replacingSheet, setReplacingSheet] = useState(false);
  const [team, setTeam] = useState<Team | null>(null);
  const [roles, setRoles] = useState<CustomRole[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [asking, setAsking] = useState<{ person: string; action: Question } | null>(null);
  const [newName, setNewName] = useState('');
  const [oneTime, setOneTime] = useState('');
  const [collectionName, setCollectionName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () =>
    Promise.all([api.team(), api.customRoles()])
      .then(([team, roles]) => {
        setTeam(team);
        setRoles(roles);
      })
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    void load();
  }, []);

  /** Runs a change, then reads the team and the person's own access again. */
  const change = async (run: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await run();
      await load();
      onChanged();
      if (done) setMessage(done);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!team) return error ? <p role="alert" className="error">{error}</p> : null;
  const shared = access.collections.filter((c) => !c.owner);
  const roleOf = (person: string, collection: string) =>
    team.grants.find((g) => g.person === person && g.collection === collection)?.role ?? '';
  const nameOf = (person: string) => team.people.find((p) => p.id === person)?.name ?? '';

  return (
    <>
      <p>
        You are signed in as <strong>{access.me.name}</strong>, an admin. Admins can open and change everything. Give
        others a role on each shared collection; everyone also has a private collection that only they and admins can
        open.
      </p>
      <table className="compare-table people">
        <caption>People</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            {shared.map((collection) => (
              <th key={collection.id} scope="col">
                {collection.name}
              </th>
            ))}
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {team.people.map((person) => (
            <tr key={person.id}>
              <th scope="row">
                {person.name}
                {person.admin && <span className="hint"> · admin</span>}
                {person.mustSetPassword && <span className="hint"> · not signed in yet</span>}
              </th>
              {shared.map((collection) => (
                <td key={collection.id}>
                  {person.admin ? (
                    <span className="hint">Admin</span>
                  ) : (
                    <select
                      aria-label={`${person.name} in ${collection.name}`}
                      value={roleOf(person.id, collection.id)}
                      disabled={busy}
                      onChange={(e) =>
                        void change(() =>
                          api.setRole(person.id, collection.id, (e.target.value || null) as Role | null)
                        )
                      }
                    >
                      {[...ROLES, ...roles.map((r) => ({ role: `role:${r.id}` as Role, label: customLabel(r) }))].map(
                        ({ role, label }) => (
                          <option key={role} value={role}>
                            {label}
                          </option>
                        )
                      )}
                    </select>
                  )}
                </td>
              ))}
              <td>
                {person.id !== access.me.id && (
                  <div className="row">
                    {person.admin ? (
                      <button type="button" className="link" onClick={() => setAsking({ person: person.id, action: 'unadmin' })}>
                        Take admin away…
                      </button>
                    ) : (
                      <button type="button" className="link" onClick={() => setAsking({ person: person.id, action: 'admin' })}>
                        Make admin…
                      </button>
                    )}
                    <button type="button" className="link" onClick={() => setAsking({ person: person.id, action: 'reset' })}>
                      Reset password…
                    </button>
                    <button
                      type="button"
                      className="link danger"
                      onClick={() => setAsking({ person: person.id, action: person.admin ? 'remove-admin' : 'remove' })}
                    >
                      Remove…
                    </button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {asking && (
        <PersonQuestion
          name={nameOf(asking.person)}
          action={asking.action}
          busy={busy}
          onCancel={() => setAsking(null)}
          onConfirm={async (password) => {
            const { person, action } = asking;
            const name = nameOf(person);
            // Taking admin away gives the organization a new recovery sheet, shown even if
            // removing them afterwards does not work. Once it is done, trying again only removes.
            let words: string[] | null = null;
            if (action === 'remove-admin') {
              const demoted = await change(async () => {
                words = await api.takeAdminAway(person);
              });
              if (!demoted) return;
              setAsking({ person, action: 'remove' });
            }
            const done = await change(
              async () => {
                if (action === 'unadmin') words = await api.takeAdminAway(person);
                else if (action === 'remove' || action === 'remove-admin') await api.removePerson(person);
                else if (action === 'reset') await api.resetPerson(person, password);
                else if (action === 'admin') await api.makeAdmin(person);
              },
              action === 'remove' || action === 'remove-admin'
                ? `${name} was removed. Collections they could open have new keys.`
                : action === 'reset'
                  ? `Pass the one-time password on to ${name}. They choose their own when they sign in.`
                  : action === 'unadmin'
                    ? `${name} is not an admin any more, and keeps their roles. Every collection has a new key.`
                    : `${name} is now an admin.`
            );
            if (done) setAsking(null);
            if (words) onOrganizationKey(words);
          }}
        />
      )}

      <form
        className="add-person"
        onSubmit={(e) => {
          e.preventDefault();
          const name = newName.trim();
          void change(() => api.addPerson(name, oneTime, []), `Pass the one-time password on to ${name}.`).then(
            (done) => {
              if (done) {
                setNewName('');
                setOneTime('');
              }
            }
          );
        }}
      >
        <h3>Add someone</h3>
        <label htmlFor="person-name">Name</label>
        <input id="person-name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <label htmlFor="person-password">One-time password</label>
        <input
          id="person-password"
          data-secret
          autoComplete="off"
          value={oneTime}
          onChange={(e) => setOneTime(e.target.value)}
          aria-describedby="person-password-hint"
        />
        <p id="person-password-hint" className="hint">
          At least {MIN_PASSWORD_CHARS} characters. Tell it to them; they choose their own password when they first sign
          in, and get their own recovery key. Then give them roles above.
        </p>
        <button type="submit" disabled={busy || !newName.trim() || [...oneTime].length < MIN_PASSWORD_CHARS}>
          Add
        </button>
      </form>

      <h3>Collections</h3>
      <ul className="plain-list">
        {shared.map((collection) => (
          <CollectionName
            key={collection.id}
            name={collection.name}
            busy={busy}
            onRename={(name) => change(() => api.renameCollection(collection.id, name))}
          />
        ))}
      </ul>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void change(() => api.createCollection(collectionName)).then((done) => done && setCollectionName(''));
        }}
      >
        <label htmlFor="collection-name" className="visually-hidden">
          New collection
        </label>
        <input
          id="collection-name"
          placeholder="New collection, such as R&D"
          value={collectionName}
          onChange={(e) => setCollectionName(e.target.value)}
        />
        <button type="submit" disabled={busy || !collectionName.trim()}>
          Add collection
        </button>
      </form>

      <h3>Roles</h3>
      <p className="hint">
        Besides the roles above, you can make your own. Each changes what you tick. With <strong>Reads recipes’
        chemistry</strong> it reads everything in the collections it is given on, as a chemist does; without it, only
        recipes’ names and details, and firings with their photos, and it can change nothing but firings. A role that
        <strong>Manages people</strong> gives and takes away the other roles on its collections. A change to a role
        applies to everyone who has it, from their next sign-in.
      </p>
      <ul className="plain-list">
        {roles.map((role) => (
          <RoleEditor
            key={role.id}
            role={role}
            busy={busy}
            onSave={(name, changes, may) => change(() => api.changeRole(role.id, name, changes, may), `${name} saved.`)}
            onDelete={() => change(() => api.deleteRole(role.id), `${role.name} deleted.`)}
          />
        ))}
        <RoleEditor
          key={`new-${roles.length}`}
          role={null}
          busy={busy}
          onSave={(name, changes, may) =>
            change(() => api.createRole(name, changes, may), `${name} made. Give it to people above.`)
          }
        />
      </ul>

      <h3>Organization recovery sheet</h3>
      <p>
        If the organization recovery sheet is lost, make a new one to print and keep safe. The old sheet stops working.
      </p>
      <div className="row">
        <button type="button" disabled={busy} onClick={() => setReplacingSheet(true)}>
          New organization recovery sheet…
        </button>
      </div>
      {replacingSheet && (
        <div className="notice warning" role="alertdialog" aria-label="New organization recovery sheet">
          <p>
            Make a new organization recovery sheet? The one you have stops working at once, so print the new one and
            keep it safe before you leave the next screen.
          </p>
          <div className="row">
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => {
                let words: string[] | null = null;
                void change(async () => {
                  words = await api.newOrganizationRecoveryKey();
                }).then(() => {
                  setReplacingSheet(false);
                  if (words) onOrganizationKey(words);
                });
              }}
            >
              Make a new sheet
            </button>
            <button type="button" autoFocus onClick={() => setReplacingSheet(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <h3>Going back to one person</h3>
      <p>
        Makes this vault yours alone again. Everyone else is removed; what was in their private collections stays,
        named after them. Every collection gets a new key, and the organization recovery sheet stops working.
      </p>
      <div className="row">
        <button type="button" className="danger" disabled={busy} onClick={() => setShrinking(true)}>
          Go back to one person…
        </button>
      </div>
      {shrinking && (
        <div className="notice warning" role="alertdialog" aria-label="Go back to one person">
          <p>
            {team.people.length > 1
              ? `${team.people
                  .filter((p) => p.id !== access.me.id)
                  .map((p) => p.name)
                  .join(', ')} can no longer sign in. `
              : ''}
            A backup of the vault as it is now is made first, in the vault's folder, in case you need to go back.
          </p>
          <div className="row">
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={async () => {
                // Not through change(): afterwards there is no team to read again.
                setBusy(true);
                setError('');
                try {
                  onShrunk(await api.goBackToOnePerson());
                } catch (e) {
                  setError(errorText(e));
                  setBusy(false);
                }
              }}
            >
              Go back to one person
            </button>
            <button type="button" onClick={() => setShrinking(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {message && <p className="hint" role="status">{message}</p>}
      {error && <p role="alert" className="error">{error}</p>}
    </>
  );
}

/**
 * Settings for someone who manages collections but is not an admin: the people on them, and the
 * roles a manager may give, which are any but an admin's or another manager's. Adding people to
 * the vault, and everything else, stays with admins.
 */
export function ManagedPeople({ access, onChanged }: { access: Access; onChanged: () => void }) {
  const [team, setTeam] = useState<Team | null>(null);
  const [roles, setRoles] = useState<CustomRole[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () =>
    Promise.all([api.team(), api.customRoles()])
      .then(([team, roles]) => {
        setTeam(team);
        setRoles(roles);
      })
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    void load();
  }, []);

  if (!team) return error ? <p role="alert" className="error">{error}</p> : null;
  const managed = access.collections.filter((c) => c.manage && !c.owner);
  const roleOf = (person: string, collection: string) =>
    team.grants.find((g) => g.person === person && g.collection === collection)?.role ?? '';
  const managing = (role: string) => role === 'admin' || roles.some((r) => `role:${r.id}` === role && r.manage);
  const offered = [
    ...ROLES,
    ...roles.filter((r) => !r.manage).map((r) => ({ role: `role:${r.id}` as Role, label: customLabel(r) }))
  ];
  const labelOf = (role: string) => {
    const custom = roles.find((r) => `role:${r.id}` === role);
    return custom ? customLabel(custom) : role === 'admin' ? 'Admin' : (ROLES.find((r) => r.role === role)?.label ?? role);
  };
  const people = team.people.filter((p) => p.id !== access.me.id && !p.admin);

  return (
    <>
      <p>
        You are signed in as <strong>{access.me.name}</strong>, and you manage{' '}
        {managed.map((c) => c.name || 'Shared').join(', ')}: you can give people roles there, other than an admin’s
        or a manager’s. Taking a role away gives the collection a new key. An admin adds people to the vault.
      </p>
      <table className="compare-table people">
        <caption>People</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            {managed.map((collection) => (
              <th key={collection.id} scope="col">
                {collection.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {people.map((person) => (
            <tr key={person.id}>
              <th scope="row">{person.name}</th>
              {managed.map((collection) => {
                const role = roleOf(person.id, collection.id);
                return (
                  <td key={collection.id}>
                    {managing(role) ? (
                      <span className="hint">{labelOf(role)}</span>
                    ) : (
                      <select
                        aria-label={`${person.name} in ${collection.name}`}
                        value={role}
                        disabled={busy}
                        onChange={(e) => {
                          setBusy(true);
                          setError('');
                          api
                            .setRole(person.id, collection.id, (e.target.value || null) as Role | null)
                            .then(load)
                            .then(onChanged)
                            .catch((err) => setError(errorText(err)))
                            .finally(() => setBusy(false));
                        }}
                      >
                        {offered.map(({ role, label }) => (
                          <option key={role} value={role}>
                            {label}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p role="alert" className="error">{error}</p>}
    </>
  );
}

/** A role an admin made, to rename or change, or a new one to make. */
function RoleEditor({
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

type Question = 'remove' | 'remove-admin' | 'reset' | 'admin' | 'unadmin';

function PersonQuestion({
  name,
  action,
  busy,
  onConfirm,
  onCancel
}: {
  name: string;
  action: Question;
  busy: boolean;
  onConfirm: (oneTimePassword: string) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  const removing = action === 'remove' || action === 'remove-admin';
  const confirm = removing
    ? `Remove ${name}`
    : action === 'reset'
      ? 'Reset password'
      : action === 'unadmin'
        ? 'Take admin away'
        : 'Make admin';
  return (
    <div className="notice warning" role="alertdialog" aria-label={confirm}>
      {removing && (
        <p>
          Remove {name}? They can no longer sign in. Every collection they could open gets a new key, which takes a
          moment. Their private collection stays, for admins.
          {action === 'remove-admin' &&
            ` ${name} is an admin, so admin is taken away first: the organization gets a new key and a new recovery sheet, which you print next. The old sheet stops working.`}
        </p>
      )}
      {action === 'unadmin' && (
        <p>
          Take admin away from {name}? They keep their roles on collections. The organization gets a new key, and every
          collection a new one, since an admin could open them all; then you print the new organization recovery sheet.
          The old sheet stops working.
        </p>
      )}
      {action === 'admin' && (
        <p>
          Make {name} an admin? They can open and change everything, and manage people. Taking admin away later gives
          every collection a new key and the organization a new recovery sheet.
        </p>
      )}
      {action === 'reset' && (
        <>
          <p>
            For when {name} has lost both their password and their recovery sheet. They get new keys, so their old
            sheet stops working, and they choose a password and get a new sheet when they next sign in.
          </p>
          <label htmlFor="reset-password">One-time password</label>
          <input
            id="reset-password"
            data-secret
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </>
      )}
      <div className="row">
        <button
          type="button"
          className={removing || action === 'unadmin' ? 'danger' : 'primary'}
          disabled={busy || (action === 'reset' && [...password].length < MIN_PASSWORD_CHARS)}
          onClick={() => onConfirm(password)}
        >
          {confirm}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function CollectionName({
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
