import { Fragment } from 'react';
import type { Revision } from '../api';

const when = (savedAt: number) =>
  new Date(savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * A record changed in two places from the same revision (docs/adr/0017-key-epochs-change-log.md):
 * which version is shown, and choosing the one to keep. Nothing is merged; the versions not kept
 * stay in the record's history.
 */
export function ForkNotice<Content>({
  head,
  name,
  readOnly,
  onKeep,
  onCompare
}: {
  head: Revision<Content>;
  name: string;
  /** The person may not change the record, so cannot choose. */
  readOnly: boolean;
  onKeep: (revisionId: string) => void;
  /** Opens Compare with the version shown and another. */
  onCompare?: (revisionId: string) => void;
}) {
  const forks = head.forks ?? [];
  if (!forks.length) return null;
  const changed = forks.filter((fork) => !fork.deleted);
  const deleted = forks.filter((fork) => fork.deleted);
  const title = <strong>{name || 'Untitled'}</strong>;
  return (
    <div className="notice" role="status">
      {changed.length > 0 && (
        <p>
          {title} was changed in two places from the same revision. You see the version saved {when(head.savedAt)};{' '}
          {changed.length === 1
            ? `the other was saved ${when(changed[0].savedAt)}.`
            : `${changed.length} others were saved too.`}{' '}
          Choose the one to keep. The others stay in its history.
        </p>
      )}
      {deleted.length > 0 && (
        <p>
          {changed.length > 0 ? 'It' : title} was deleted on another computer {when(deleted[0].savedAt)}, where this
          version had not arrived yet. Keep it, or delete it.
        </p>
      )}
      {readOnly ? (
        <p className="hint">Someone who may change it can choose.</p>
      ) : (
        <div className="row">
          <button type="button" className="primary" onClick={() => onKeep(head.revisionId)}>
            {changed.length ? 'Keep this version' : 'Keep it'}
          </button>
          {changed.map((fork) => (
            <Fragment key={fork.revisionId}>
              <button type="button" onClick={() => onKeep(fork.revisionId)}>
                {changed.length === 1 ? 'Keep the other' : `Keep the one saved ${when(fork.savedAt)}`}
              </button>
              {onCompare && (
                <button type="button" onClick={() => onCompare(fork.revisionId)}>
                  Compare{changed.length === 1 ? '' : ` with the one saved ${when(fork.savedAt)}`}…
                </button>
              )}
            </Fragment>
          ))}
          {deleted.slice(0, 1).map((fork) => (
            <button key={fork.revisionId} type="button" className="danger" onClick={() => onKeep(fork.revisionId)}>
              Delete it
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
