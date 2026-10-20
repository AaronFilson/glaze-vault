import { useEffect, useState } from 'react';
import { api, type Kind } from './api';
import type { RecipeContent, RecipeLine } from './chemistry';

/** The lines of a recipe or batch sheet revision: the newest's, or an earlier one's from its
 * history. Null until known, or when it cannot be opened. */
export function useRevisionLines(
  kind: Kind,
  head: { recordId: string; number: number; content: RecipeContent } | null,
  number: number | null
): RecipeLine[] | null {
  const newest = head && number !== null && head.number === number ? head.content.lines : null;
  const [earlier, setEarlier] = useState<{ key: string; lines: RecipeLine[] } | null>(null);
  const key = head && number !== null ? `${kind}/${head.recordId}/${number}` : '';
  useEffect(() => {
    if (!head || number === null || newest) return;
    let live = true;
    api
      .history<RecipeContent>(kind, head.recordId)
      .then((list) => {
        const revision = list.find((r) => r.number === number);
        if (live && revision) setEarlier({ key, lines: revision.content.lines ?? [] });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key, !!newest]);
  return newest ?? (earlier?.key === key ? earlier.lines : null);
}
