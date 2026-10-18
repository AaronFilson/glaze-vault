// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { shino, spar, fakeCore, show } from './recipesTestKit';

// The whole screen renders in jsdom, with the materials list, so give it time on slow machines.
vi.setConfig({ testTimeout: 30_000 });

it('shows an earlier revision and makes it the newest', async () => {
  const third = { ...shino, revisionId: 'revision-3', number: 3, content: { ...shino.content, name: 'Shino 3' } };
  const first = { ...shino, revisionId: 'revision-1', number: 1, content: { ...shino.content, name: 'Shino 1' } };
  const second = { ...shino, revisionId: 'revision-2', number: 2, content: { ...shino.content, name: 'Shino 2' } };
  const core = fakeCore({ recipes: [third], history: [third, second, first] });
  show();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Shino 3' }));
  await user.click(screen.getByText('Earlier revisions (2)'));
  await user.click(await screen.findByRole('button', { name: /^Revision 1 ·/ }));
  expect(core.called('record_history')[0].args).toEqual({ kind: 'recipe', recordId: 'record-1' });
  expect(screen.queryByRole('button', { name: /^Revision 3 ·/ })).toBeNull();

  const name = screen.getByLabelText('Recipe name') as HTMLInputElement;
  expect(name.value).toBe('Shino 1');
  expect(name.matches(':disabled')).toBe(true);
  expect(screen.getByText(/This is revision 1 of 3/)).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Use this revision' }));
  expect(name.value).toBe('Shino 1');
  expect(name.matches(':disabled')).toBe(false);
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(core.called('save_record')).toHaveLength(1));
  expect(core.called('save_record')[0].args).toMatchObject({ parent: 'revision-3', content: { name: 'Shino 1' } });
});

describe('deleting', () => {
  it('moves a recipe to Deleted, and restores it from there', async () => {
    const core = fakeCore();
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Shino' }));
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    expect(screen.getByRole('alertdialog', { name: 'Delete' }).textContent).toContain('Delete Shino?');
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(core.called('delete_record')).toHaveLength(1));
    expect(core.called('delete_record')[0].args).toEqual({ kind: 'recipe', newest: 'revision-1' });
    expect(await screen.findByText('No recipes yet.')).toBeTruthy();

    await user.click(screen.getByText('Deleted (1)'));
    await user.click(screen.getByRole('button', { name: 'Shino' }));
    expect(screen.getByText(/was deleted/)).toBeTruthy();
    expect((screen.getByLabelText('Recipe name') as HTMLInputElement).matches(':disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(core.called('save_record')).toHaveLength(1));
    expect(core.called('save_record')[0].args).toMatchObject({ kind: 'recipe', parent: 'deleted-revision-1' });
    expect(screen.queryByText('Deleted (1)')).toBeNull();
    expect((screen.getByLabelText('Recipe name') as HTMLInputElement).value).toBe('Shino');
  });

  it('erases a deleted recipe after asking', async () => {
    const gone = { ...shino, revisionId: 'revision-2', number: 2, deleted: true };
    const core = fakeCore({ recipes: [], deleted: [gone] });
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByText('Deleted (1)'));
    await user.click(screen.getByRole('button', { name: 'Shino' }));
    await user.click(screen.getByRole('button', { name: 'Erase permanently…' }));
    expect(screen.getByRole('alertdialog').textContent).toContain('cannot be brought back');
    await user.click(screen.getByRole('button', { name: 'Erase permanently' }));
    await waitFor(() => expect(core.called('erase_record')).toHaveLength(1));
    expect(core.called('erase_record')[0].args).toEqual({ kind: 'recipe', recordId: 'record-1' });
    expect(screen.queryByText(/Deleted \(/)).toBeNull();
  });

  it('says what deleting a material does to the recipes that use it', async () => {
    fakeCore({
      recipes: [{ ...shino, content: { ...shino.content, lines: [{ material: 'Spar, lot 7', amount: '10' }] } }],
      materials: [spar, { ...spar, recordId: 'material-2', revisionId: 'r-silica', content: { ...spar.content, name: 'Silica' } }]
    });
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Materials' }));
    await user.click(screen.getByRole('button', { name: 'Spar, lot 7' }));
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    expect(screen.getByRole('alertdialog').textContent).toContain('1 recipe uses it, and will not find it until it is restored.');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Silica' }));
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    expect(screen.getByRole('alertdialog').textContent).not.toContain('recipe uses');
  });

  it('does not restore a material over another of the same name', async () => {
    const gone = { ...spar, revisionId: 'material-revision-2', number: 2, deleted: true };
    const core = fakeCore({ materials: [{ ...spar, recordId: 'material-9', revisionId: 'r-9' }], deleted: [gone] });
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Materials' }));
    await user.click(screen.getByText('Deleted (1)'));
    await user.click(within(screen.getByText('Deleted (1)').closest('details')!).getByRole('button', { name: 'Spar, lot 7' }));
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(screen.getByRole('alert').textContent).toContain('You have another material called Spar, lot 7.');
    expect(core.called('save_record')).toHaveLength(0);
  });
});

describe('comparing', () => {
  it('compares unsaved changes with what they started from', async () => {
    fakeCore();
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Shino' }));
    fireEvent.change(screen.getByLabelText('Amount 1'), { target: { value: '25' } });
    fireEvent.change(screen.getByLabelText('Material 1'), { target: { value: 'Nepheline Syenite' } });
    await user.click(screen.getByRole('button', { name: 'Add material' }));
    fireEvent.change(screen.getByLabelText('Material 2'), { target: { value: 'Whiting' } });
    fireEvent.change(screen.getByLabelText('Amount 2'), { target: { value: '25' } });
    await user.click(screen.getByRole('button', { name: 'Compare…' }));

    const batch = screen.getByRole('table', { name: 'Batch, percent of each' });
    const rows = [...batch.querySelectorAll('tbody tr')].map((row) => row.textContent);
    expect(rows).toEqual(['Nepheline Syenite100.050.0−50.0', 'Whiting—50.0added']);
    expect(screen.getByRole('table', { name: 'Unity formula' }).textContent).toContain('CaO');
    expect((screen.getByLabelText('Recipe', { selector: '#second-recipe' }) as HTMLSelectElement).value).toBe('draft');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect((screen.getByLabelText('Amount 2') as HTMLInputElement).value).toBe('25');
  });

  it('compares an earlier revision with the newest', async () => {
    const second = { ...shino, revisionId: 'revision-2', number: 2, content: { ...shino.content, notes: 'Thinner' } };
    fakeCore({ recipes: [second], history: [second, shino] });
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Shino' }));
    await user.click(screen.getByText('Earlier revisions (1)'));
    await user.click(await screen.findByRole('button', { name: /^Revision 1 ·/ }));
    await user.click(screen.getByRole('button', { name: 'Compare with the newest' }));
    expect(await screen.findByRole('heading', { name: 'Shino, revision 1' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Shino' })).toBeTruthy();
    expect(screen.getByText('Thinner')).toBeTruthy();
  });
});

describe('saving on the way', () => {
  it('reopens the recipe being saved at the revision just saved', async () => {
    const core = fakeCore();
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Shino' }));
    fireEvent.change(screen.getByLabelText('Recipe name'), { target: { value: 'Shino 2' } });
    await user.click(screen.getByRole('button', { name: 'Shino' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(core.called('save_record')).toHaveLength(1));
    expect((screen.getByLabelText('Recipe name') as HTMLInputElement).value).toBe('Shino 2');
    expect(screen.getByText(/revision 2$/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Recipe name'), { target: { value: 'Shino 3' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(core.called('save_record')).toHaveLength(2));
    expect(core.called('save_record')[1].args.parent).toBe('saved-revision-1');
  });

  it('uses an earlier revision on top of the edits just saved', async () => {
    const second = { ...shino, revisionId: 'revision-2', number: 2, content: { ...shino.content, name: 'Shino 2' } };
    const core = fakeCore({ recipes: [second], history: [second, shino] });
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Shino 2' }));
    fireEvent.change(screen.getByLabelText('Recipe name'), { target: { value: 'Shino, edited' } });
    await user.click(screen.getByText('Earlier revisions (1)'));
    await user.click(await screen.findByRole('button', { name: /^Revision 1 ·/ }));
    await user.click(screen.getByRole('button', { name: 'Use this revision' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(core.called('save_record')).toHaveLength(1));
    expect(core.called('save_record')[0].args).toMatchObject({ parent: 'revision-2', content: { name: 'Shino, edited' } });

    const name = screen.getByLabelText('Recipe name') as HTMLInputElement;
    expect(name.value).toBe('Shino');
    expect(name.matches(':disabled')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(core.called('save_record')).toHaveLength(2));
    expect(core.called('save_record')[1].args).toMatchObject({ parent: 'saved-revision-1', content: { name: 'Shino' } });
  });
});
