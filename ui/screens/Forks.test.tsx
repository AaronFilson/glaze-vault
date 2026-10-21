// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { RecipeHead } from '../api';
import { fakeCore, shino, show } from './recipesTestKit';

vi.setConfig({ testTimeout: 30_000 });

// The same recipe changed in two places from its first revision (ADR 17).
const theirs: RecipeHead = {
  ...shino,
  revisionId: 'revision-theirs',
  number: 2,
  savedAt: shino.savedAt + 60_000,
  content: { ...shino.content, name: 'Shino', lines: [{ material: 'Custer Feldspar', amount: '50' }] }
};
const ours: RecipeHead = { ...shino, revisionId: 'revision-ours', number: 2, savedAt: shino.savedAt + 120_000 };

const notice = () => screen.getByText(/was changed in two places/).closest('.notice') as HTMLElement;

it('shows a recipe that forked, compares the versions and keeps the one chosen', async () => {
  const forked = { ...ours, forks: [{ revisionId: theirs.revisionId, savedAt: theirs.savedAt, deleted: false }] };
  const core = fakeCore({ recipes: [forked], history: [forked, theirs, shino] });
  show();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Shino' }));
  expect(notice().textContent).toContain('The others stay in its history');

  await user.click(within(notice()).getByRole('button', { name: 'Compare…' }));
  expect((await screen.findAllByText('Shino, other version')).length).toBeGreaterThan(0);
  expect(screen.getByText('Custer Feldspar')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Done' }));

  await user.click(within(notice()).getByRole('button', { name: 'Keep the other' }));
  await waitFor(() => expect(core.called('resolve_fork')).toHaveLength(1));
  expect(core.called('resolve_fork')[0].args).toEqual({
    kind: 'recipe',
    keep: theirs.revisionId,
    others: [ours.revisionId]
  });
  await waitFor(() => expect(screen.queryByText(/was changed in two places/)).toBeNull());
  expect((screen.getByLabelText('Material 1') as HTMLInputElement).value).toBe('Custer Feldspar');
});

it('keeps or deletes a recipe deleted on another computer', async () => {
  const forked = { ...ours, forks: [{ revisionId: 'revision-gone', savedAt: theirs.savedAt, deleted: true }] };
  const gone = { ...shino, revisionId: 'revision-gone', number: 2, deleted: true };
  const core = fakeCore({ recipes: [forked], history: [forked, shino, gone] });
  show();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Shino' }));
  const deletedNotice = screen.getByText(/was deleted on another computer/).closest('.notice') as HTMLElement;
  expect(within(deletedNotice).queryByRole('button', { name: 'Keep the other' })).toBeNull();
  await user.click(within(deletedNotice).getByRole('button', { name: 'Delete it' }));
  await waitFor(() => expect(core.called('resolve_fork')).toHaveLength(1));
  expect(core.called('resolve_fork')[0].args).toMatchObject({ keep: 'revision-gone', others: [ours.revisionId] });
  // It goes to the deleted ones.
  await waitFor(() => expect(screen.queryByText(/was deleted on another computer/)).toBeNull());
  expect(screen.getByText('Deleted (1)')).toBeTruthy();
  expect(screen.getByText('No recipes yet.')).toBeTruthy();
});
