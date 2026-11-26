import { useEffect, useState } from 'react';
import { api, errorText, MIN_PASSWORD_CHARS, type Access, type CustomRole, type Role, type Team } from '../api';
import { CollectionName, customLabel, ROLES } from './TeamRoles';

export type Question = 'remove' | 'remove-admin' | 'reset' | 'admin' | 'unadmin';

export function PersonQuestion({
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
  const rename = async (collection: string, name: string) => {
    setBusy(true);
    setError('');
    try {
      await api.renameCollection(collection, name.trim());
      await load();
      onChanged();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p>
        You are signed in as <strong>{access.me.name}</strong>, and you manage{' '}
        {managed.map((c) => c.name || 'Shared').join(', ')}: you can give people roles there, other than an admin’s
        or a manager’s, and rename {managed.length > 1 ? 'them' : 'it'}. Taking a role away gives the collection a new
        key. An admin adds people to the vault.
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
      <h3>Collections</h3>
      <ul className="plain-list">
        {managed.map((collection) => (
          <CollectionName
            key={collection.id}
            name={collection.name}
            busy={busy}
            onRename={(name) => rename(collection.id, name)}
          />
        ))}
      </ul>
      {error && <p role="alert" className="error">{error}</p>}
    </>
  );
}
