import type { Revision } from '../api';

const when = (savedAt: number) =>
  new Date(savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** A sidebar's deleted records, to look at, restore or erase. */
export function DeletedList<Content>({
  deleted,
  nameOf,
  viewing,
  onOpen
}: {
  deleted: Revision<Content>[];
  nameOf: (content: Content) => string;
  viewing: Revision<Content> | null;
  onOpen: (revision: Revision<Content>) => void;
}) {
  if (!deleted.length) return null;
  return (
    <details className="deleted">
      <summary>Deleted ({deleted.length})</summary>
      <ul className="list">
        {deleted.map((revision) => (
          <li key={revision.recordId}>
            <button
              type="button"
              aria-current={revision.revisionId === viewing?.revisionId}
              onClick={() => onOpen(revision)}
            >
              {nameOf(revision.content) || 'Untitled'}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Says a deleted record is showing, and offers to restore or erase it. */
export function DeletedNotice<Content>({
  deleted,
  name,
  onRestore,
  onErase
}: {
  deleted: Revision<Content>;
  name: string;
  onRestore: () => void;
  onErase: () => void;
}) {
  return (
    <div className="notice" role="status">
      <p>
        <strong>{name || 'Untitled'}</strong> was deleted {when(deleted.savedAt)}. Restore it to use and change it
        again, or erase it for good.
      </p>
      <div className="row">
        <button type="button" className="primary" onClick={onRestore}>
          Restore
        </button>
        <button type="button" className="danger" onClick={onErase}>
          Erase permanently…
        </button>
      </div>
    </div>
  );
}

/** The question before deleting or erasing. */
export function ConfirmNotice({
  children,
  confirm,
  onConfirm,
  onCancel
}: {
  children: React.ReactNode;
  confirm: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="notice warning" role="alertdialog" aria-label={confirm}>
      {children}
      <div className="row">
        <button type="button" className="danger" onClick={onConfirm}>
          {confirm}
        </button>
        <button type="button" autoFocus onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
