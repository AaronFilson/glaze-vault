import { useEffect, useRef } from 'react';
import { api, type Draft, type Revision } from './api';

/** How long after the last keystroke unsaved edits are kept as a draft. */
export const DRAFT_DELAY_MS = 1000;

/** An open firing or mix moved to the newest revision a sync brought, unless it has unsaved
 * edits, as `useEditor`'s `follow` does for recipes and materials. */
export function followed<Content, Open extends { current: Revision<Content> | null; draft: Content }>(
  open: Open | null,
  heads: Revision<Content>[]
): Open | null {
  if (!open?.current || JSON.stringify(open.draft) !== JSON.stringify(open.current.content)) return open;
  const head = heads.find((h) => h.recordId === open.current?.recordId);
  if (!head || head.revisionId === open.current.revisionId) return open;
  return { ...open, current: head, draft: head.content };
}

/** Serializes encrypted draft writes and debounces saving unsaved edits after typing. */
export function useDraftSync(loaded: boolean, unsaved: Draft | null) {
  // Whether the vault holds a draft, so one is only cleared when there is one.
  const draftKept = useRef(false);
  // Draft writes, one after another: the core runs commands side by side, and a draft kept after
  // it was cleared would come back.
  const draftWrites = useRef<Promise<unknown>>(Promise.resolve());
  const writeDraft = <T,>(write: () => Promise<T>): Promise<T> => {
    const done = draftWrites.current.then(write);
    draftWrites.current = done.catch(() => {});
    return done;
  };

  const unsavedJson = JSON.stringify(unsaved);
  useEffect(() => {
    if (!loaded) return;
    if (!unsaved) {
      if (draftKept.current) {
        draftKept.current = false;
        writeDraft(api.clearDraft).catch(() => {});
      }
      return;
    }
    const timer = setTimeout(() => {
      draftKept.current = true;
      writeDraft(() => api.saveDraft(unsaved)).catch(() => {});
    }, DRAFT_DELAY_MS);
    return () => clearTimeout(timer);
    // unsavedJson stands for unsaved, which is a new object every render.
  }, [loaded, unsavedJson]);

  const markDraftLoaded = (hasDraft: boolean) => {
    draftKept.current = hasDraft;
  };

  return { writeDraft, markDraftLoaded };
}
