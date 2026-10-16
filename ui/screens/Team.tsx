import { useEffect, useId, useState } from 'react';
import { api, errorText, MIN_PASSWORD_CHARS, type Access, type Role, type Team } from '../api';
import { collectionLabel, editableCollections } from '../team';

/** Where a new recipe or material is saved, in a team's vault. */
export function CollectionPicker({
  access,
  names,
  value,
  onChange
}: {
  access: Access;
  names: Record<string, string>;
  value: string | null;
  onChange: (collection: string) => void;
}) {
  const id = useId();
  return (
    <div className="row">
      <label htmlFor={id}>Save in</label>
      <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        {editableCollections(access).map((collection) => (
          <option key={collection.id} value={collection.id}>
            {collectionLabel(collection, access, names)}
          </option>
        ))}
      </select>
    </div>
  );
}

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
            called Shared, and you get a private one. Going back to one person is not in this version yet.
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
  { role: 'chemist', label: 'Chemist: reads' },
  { role: 'formulator', label: 'Formulator: changes' }
];

/** Settings for a team's admin: people, what each may do in each collection, and collections. */
export function People({ access, onChanged }: { access: Access; onChanged: () => void }) {
  const [team, setTeam] = useState<Team | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [asking, setAsking] = useState<{ person: string; action: 'remove' | 'reset' | 'admin' } | null>(null);
  const [newName, setNewName] = useState('');
  const [oneTime, setOneTime] = useState('');
  const [collectionName, setCollectionName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () =>
    api
      .team()
      .then(setTeam)
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
                      {ROLES.map(({ role, label }) => (
                        <option key={role} value={role}>
                          {label}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
              ))}
              <td>
                {person.id !== access.me.id && (
                  <div className="row">
                    {!person.admin && (
                      <button type="button" className="link" onClick={() => setAsking({ person: person.id, action: 'admin' })}>
                        Make admin…
                      </button>
                    )}
                    <button type="button" className="link" onClick={() => setAsking({ person: person.id, action: 'reset' })}>
                      Reset password…
                    </button>
                    {!person.admin && (
                      <button
                        type="button"
                        className="link danger"
                        onClick={() => setAsking({ person: person.id, action: 'remove' })}
                      >
                        Remove…
                      </button>
                    )}
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
            const done = await change(
              () =>
                action === 'remove'
                  ? api.removePerson(person)
                  : action === 'reset'
                    ? api.resetPerson(person, password)
                    : api.makeAdmin(person),
              action === 'remove'
                ? `${name} was removed. Collections they could open have new keys.`
                : action === 'reset'
                  ? `Pass the one-time password on to ${name}. They choose their own when they sign in.`
                  : `${name} is now an admin.`
            );
            if (done) setAsking(null);
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

      {message && <p className="hint" role="status">{message}</p>}
      {error && <p role="alert" className="error">{error}</p>}
    </>
  );
}

function PersonQuestion({
  name,
  action,
  busy,
  onConfirm,
  onCancel
}: {
  name: string;
  action: 'remove' | 'reset' | 'admin';
  busy: boolean;
  onConfirm: (oneTimePassword: string) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  const confirm = action === 'remove' ? `Remove ${name}` : action === 'reset' ? 'Reset password' : 'Make admin';
  return (
    <div className="notice warning" role="alertdialog" aria-label={confirm}>
      {action === 'remove' && (
        <p>
          Remove {name}? They can no longer sign in. Every collection they could open gets a new key, which takes a
          moment. Their private collection stays, for admins.
        </p>
      )}
      {action === 'admin' && (
        <p>
          Make {name} an admin? They can open and change everything, and manage people. In this version, an admin
          cannot be made an ordinary member again, or removed.
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
          className={action === 'remove' ? 'danger' : 'primary'}
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
