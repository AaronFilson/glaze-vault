import { useState } from 'react';
import { api, errorText, type Kind, type Revision } from '../api';
import { ForkNotice } from './ForkNotice';

/** The fork notice for records whose screens keep their own lists (firings, mixes, batch sheets,
 * limit sets and price lists): choosing a version saves the revision that ends the fork, and
 * hands it back for the list. */
export function ForkChoice<Content>({
  kind,
  head,
  name,
  readOnly,
  onResolved
}: {
  kind: Kind;
  head: Revision<Content>;
  name: string;
  readOnly: boolean;
  /** The revision kept; one that deletes the record leaves the list. */
  onResolved: (saved: Revision<Content>) => void;
}) {
  const [error, setError] = useState('');
  if (!head.forks?.length) return null;
  const keep = async (revisionId: string) => {
    setError('');
    const others = [head.revisionId, ...(head.forks ?? []).map((fork) => fork.revisionId)].filter(
      (id) => id !== revisionId
    );
    try {
      onResolved(await api.resolveFork<Content>(kind, revisionId, others));
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <>
      <ForkNotice head={head} name={name} readOnly={readOnly} onKeep={(id) => void keep(id)} />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </>
  );
}
