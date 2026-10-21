import { useEffect, useState } from 'react';
import { api, errorText, type Kind, type Revision } from '../api';

const when = (savedAt: number) =>
  new Date(savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Who saved a revision, and what its signature says (docs/adr/0019-signatures-and-audit-log.md).
 * In a one-person vault there is nobody to name, so only a signature that does not check is said. */
export function savedBy(revision: Revision<unknown>, names: Record<string, string>, team: boolean): string {
  const name = (id: string | undefined) => (id ? (names[id] ?? 'someone no longer in the vault') : 'someone');
  const parts: string[] = [];
  if (team && revision.author) parts.push(`by ${name(revision.author)}`);
  const signed = revision.signed;
  if (signed?.check === 'bad') parts.push('⚠ changed outside the app: its signature does not match');
  else if (signed?.check === 'unconfirmed') parts.push('signed with a key no admin has certified yet');
  if (team && signed?.check !== 'bad') {
    if (signed?.as === 'attester') parts.push(`vouched for by ${name(signed.by)}`);
    if (signed?.as === 'mover') parts.push(`moved by ${name(signed.by)}`);
  }
  return parts.join(' · ');
}

/** A record's earlier revisions, to look at one. Loaded when opened. */
export function RevisionHistory<Content>({
  kind,
  current,
  viewing,
  onView
}: {
  kind: Kind;
  current: Revision<Content>;
  viewing: Revision<Content> | null;
  onView: (revision: Revision<Content> | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [revisions, setRevisions] = useState<Revision<Content>[] | null>(null);
  const [error, setError] = useState('');
  // The lock screen's list of people names everyone in a team's vault.
  const [names, setNames] = useState<Record<string, string> | null>(null);

  // A new save makes the list out of date.
  useEffect(() => setRevisions(null), [current.revisionId]);

  useEffect(() => {
    if (!open || revisions) return;
    api
      .history<Content>(kind, current.recordId)
      .then((all) => setRevisions(all.filter((r) => r.revisionId !== current.revisionId)))
      .catch((e) => setError(errorText(e)));
  }, [open, revisions, kind, current.recordId, current.revisionId]);

  useEffect(() => {
    if (!open || names) return;
    api
      .status()
      .then((status) => setNames(Object.fromEntries(status.people.map((p) => [p.id, p.name]))))
      .catch(() => setNames({}));
  }, [open, names]);
  const team = !!names && Object.keys(names).length > 0;

  if (current.number < 2) return null;
  return (
    <details className="history" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Earlier revisions ({current.number - 1})</summary>
      {error && <p className="error">{error}</p>}
      {!revisions && !error && <p className="hint">Loading…</p>}
      {revisions && (
        <ul className="list">
          {revisions.map((revision) => {
            const by = savedBy(revision, names ?? {}, team);
            return (
              <li key={revision.revisionId}>
                <button
                  type="button"
                  aria-current={revision.revisionId === viewing?.revisionId}
                  onClick={() => onView(revision.revisionId === viewing?.revisionId ? null : revision)}
                >
                  Revision {revision.number} · {when(revision.savedAt)}
                </button>
                {by && <span className={revision.signed?.check === 'bad' ? 'warn' : 'hint'}> {by}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
}

/** Says that an earlier revision is showing, and offers to make it the newest. */
export function ViewingNotice<Content>({
  viewing,
  newest,
  onUse,
  onBack,
  onCompare
}: {
  viewing: Revision<Content>;
  newest: Revision<Content>;
  onUse: () => void;
  onBack: () => void;
  onCompare?: () => void;
}) {
  return (
    <div className="notice" role="status">
      <p>
        This is revision {viewing.number} of {newest.number}, saved {when(viewing.savedAt)}. Earlier revisions cannot be
        changed. Use this one to edit it, and saving makes it revision {newest.number + 1}.
      </p>
      <div className="row">
        <button type="button" className="primary" onClick={onUse}>
          Use this revision
        </button>
        <button type="button" onClick={onBack}>
          Back to the newest
        </button>
        {onCompare && (
          <button type="button" onClick={onCompare}>
            Compare with the newest
          </button>
        )}
      </div>
    </div>
  );
}
