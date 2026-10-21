import { useEffect, useMemo, useState } from 'react';
import { api, errorText, type Access, type AuditLog as Log, type Person } from '../api';
import { auditCsv, describe, personName, type AuditNames } from '../audit';
import { localDate } from '../export';
import { collectionLabel } from '../team';

/** How many entries the screen shows; the export has them all. */
const SHOWN = 200;

const when = (at: number) =>
  new Date(at).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  });

const MARKS = {
  good: '',
  unconfirmed: 'Signed with a key no admin has certified yet',
  bad: 'Its signature does not match: it was changed outside the app'
};

/** The audit log, for an admin (docs/adr/0019-signatures-and-audit-log.md): who did what, newest
 * first, with names put back where this person can see them. Loaded when opened. */
export function AuditLog({
  access,
  people,
  records
}: {
  access: Access | null;
  people: Person[];
  /** Names of the records this person can open, by id. */
  records: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<Log | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const names = useMemo<AuditNames>(() => {
    const byId: Record<string, string> = Object.fromEntries(people.map((p) => [p.id, p.name]));
    if (access) byId[access.me.id] = access.me.name || 'You';
    const collections = access
      ? Object.fromEntries(access.collections.map((c) => [c.id, collectionLabel(c, access, byId)]))
      : {};
    return { people: byId, collections, records };
  }, [access, people, records]);

  useEffect(() => {
    if (!open || log) return;
    api
      .auditLog(SHOWN)
      .then(setLog)
      .catch((e) => setError(errorText(e)));
  }, [open, log]);

  const exportAll = async () => {
    setError('');
    setMessage('');
    try {
      const all = await api.auditLog(null);
      const saved = await api.saveExport(
        `Glaze Vault audit log ${localDate(new Date())}.csv`,
        auditCsv(all.entries, names)
      );
      if (saved) setMessage(`Saved ${saved}.`);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const doubtful = log?.entries.filter((e) => e.check !== 'good').length ?? 0;
  return (
    <details className="history" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Show the audit log</summary>
      <p>
        Who saved, changed, opened, printed or exported what, and when. Opening, printing and exporting are what the app
        reports: they show what it did, not proof of what someone read.
      </p>
      {error && <p className="error">{error}</p>}
      {!log && !error && <p className="hint">Loading…</p>}
      {log && (
        <>
          {!log.intact && (
            <div className="notice warning" role="alert">
              <p>
                Entries in the log were changed or taken out outside the app. What it says may not be all that happened.
              </p>
            </div>
          )}
          {doubtful > 0 && (
            <p className="hint">
              {doubtful} of the entries shown have a signature that is not confirmed or does not match: they are marked.
            </p>
          )}
          <table className="lines audit">
            <caption>
              {log.entries.length < SHOWN ? 'Every entry' : `The newest ${SHOWN} entries`}, newest first
            </caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">What</th>
              </tr>
            </thead>
            <tbody>
              {log.entries.map((entry) => (
                <tr key={entry.seq}>
                  <td>{when(entry.at)}</td>
                  <td>{personName(entry.person, names)}</td>
                  <td>
                    {describe(entry, names)}
                    {entry.check !== 'good' && (
                      <>
                        {' '}
                        <span className="warn" title={MARKS[entry.check]}>
                          ⚠ {MARKS[entry.check]}
                        </span>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row">
            <button type="button" onClick={exportAll}>
              Export the whole log (CSV)
            </button>
          </div>
          {message && (
            <p className="hint" role="status">
              {message}
            </p>
          )}
        </>
      )}
    </details>
  );
}
