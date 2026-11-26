import { useEffect, useState } from 'react';

/** A section that opens when what it holds asks for it, and stays as the person leaves it:
 * clearing the field being typed in does not fold it shut. */
export function Fold({ open, children }: { open: boolean; children: React.ReactNode }) {
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) setShown(true);
  }, [open]);
  return (
    <details className="bar" open={shown} onToggle={(e) => setShown((e.target as HTMLDetailsElement).open)}>
      {children}
    </details>
  );
}

export function PendingNotice({
  name,
  label = 'Unsaved firing',
  onSave,
  onDiscard,
  onStay
}: {
  name: string;
  label?: string;
  onSave: () => void;
  onDiscard: () => void;
  onStay: () => void;
}) {
  return (
    <div className="notice warning" role="alertdialog" aria-label={label}>
      <p>
        <strong>{name}</strong> has changes that are not saved.
      </p>
      <div className="row">
        <button type="button" className="primary" autoFocus onClick={onSave}>
          Save
        </button>
        <button type="button" onClick={onDiscard}>
          Discard changes
        </button>
        <button type="button" onClick={onStay}>
          Keep editing
        </button>
      </div>
    </div>
  );
}
