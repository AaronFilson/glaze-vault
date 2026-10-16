import { useEffect, useState } from 'react';
import { api, errorText, type Kind, type Revision } from '../api';

const when = (savedAt: number) =>
  new Date(savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

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

  // A new save makes the list out of date.
  useEffect(() => setRevisions(null), [current.revisionId]);

  useEffect(() => {
    if (!open || revisions) return;
    api
      .history<Content>(kind, current.recordId)
      .then((all) => setRevisions(all.filter((r) => r.revisionId !== current.revisionId)))
      .catch((e) => setError(errorText(e)));
  }, [open, revisions, kind, current.recordId, current.revisionId]);

  if (current.number < 2) return null;
  return (
    <details className="history" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Earlier revisions ({current.number - 1})</summary>
      {error && <p className="error">{error}</p>}
      {!revisions && !error && <p className="hint">Loading…</p>}
      {revisions && (
        <ul className="list">
          {revisions.map((revision) => (
            <li key={revision.revisionId}>
              <button
                type="button"
                aria-current={revision.revisionId === viewing?.revisionId}
                onClick={() => onView(revision.revisionId === viewing?.revisionId ? null : revision)}
              >
                Revision {revision.number} · {when(revision.savedAt)}
              </button>
            </li>
          ))}
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
  onBack
}: {
  viewing: Revision<Content>;
  newest: Revision<Content>;
  onUse: () => void;
  onBack: () => void;
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
      </div>
    </div>
  );
}
