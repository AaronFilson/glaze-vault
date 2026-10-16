import { useState } from 'react';
import type { DraftPart, Revision } from './api';

interface EditorState<Content> {
  /** The saved revision the edits start from; null for a record not saved yet. */
  current: Revision<Content> | null;
  draft: Content;
  /** An earlier revision being looked at instead, read-only. */
  viewing: Revision<Content> | null;
}

/**
 * An editor for one kind of record: the saved revision it started from, the edits, and an
 * earlier revision being looked at instead.
 *
 * Its actions build on the state as it is when they run, not as it was when they were made, so
 * one queued behind the unsaved-changes question still sees the save that answered it.
 */
export function useEditor<Content>(empty: Content, same: (a: Content, b: Content) => boolean) {
  const [state, setState] = useState<EditorState<Content>>({ current: null, draft: empty, viewing: null });
  const { current, draft, viewing } = state;
  const changed = !same(draft, current?.content ?? empty);

  /** Shows a saved revision, or a new record with nothing saved, optionally with edits on top. */
  const show = (revision: Revision<Content> | null, content?: Content) =>
    setState({ current: revision, draft: content ?? revision?.content ?? empty, viewing: null });

  /**
   * Opens a record from the list. The editor may already hold a newer revision of it than the
   * list did when it was chosen, from saving it on the way, and then that one is kept.
   */
  const open = (revision: Revision<Content> | null) =>
    setState((prev) => {
      const newest =
        revision && prev.current?.recordId === revision.recordId && prev.current.number > revision.number
          ? prev.current
          : revision;
      return { current: newest, draft: newest?.content ?? empty, viewing: null };
    });

  /** Puts content in the editor as unsaved edits to the current revision, such as an earlier one's. */
  const edit = (content: Content) => setState((prev) => ({ ...prev, draft: content, viewing: null }));

  /** Drops the unsaved edits. */
  const discard = () => setState((prev) => ({ ...prev, draft: prev.current?.content ?? empty, viewing: null }));

  const setDraft = (content: Content) => setState((prev) => ({ ...prev, draft: content }));
  const setViewing = (revision: Revision<Content> | null) => setState((prev) => ({ ...prev, viewing: revision }));

  /** The unsaved edits, to keep as a draft, or undefined when there are none. */
  const part: DraftPart<Content> | undefined = changed
    ? { recordId: current?.recordId ?? null, revisionId: current?.revisionId ?? null, content: draft }
    : undefined;

  return { current, draft, setDraft, changed, viewing, setViewing, show, open, edit, discard, part };
}

export type Editor<Content> = ReturnType<typeof useEditor<Content>>;

/**
 * Where a kept draft's edits go back: on top of the newest revision of its record, or as a new
 * record. Null when they are already saved, because the draft was kept just before a save and
 * the app closed before it could be cleared.
 */
export function restorePart<Content>(
  part: DraftPart<Content>,
  heads: Revision<Content>[],
  same: (a: Content, b: Content) => boolean
): { current: Revision<Content> | null; content: Content } | null {
  if (part.recordId) {
    const head = heads.find((h) => h.recordId === part.recordId);
    if (!head || same(head.content, part.content)) return null;
    return { current: head, content: part.content };
  }
  if (heads.some((h) => same(h.content, part.content))) return null;
  return { current: null, content: part.content };
}
