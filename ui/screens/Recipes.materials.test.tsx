// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { shino, spar, fakeCore, show } from './recipesTestKit';

// The whole screen renders in jsdom, with the materials list, so give it time on slow machines.
vi.setConfig({ testTimeout: 30_000 });

describe('your materials', () => {
  it('are made from a standard material’s analysis and saved', async () => {
    const core = fakeCore();
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Materials' }));
    expect(screen.getByText(/No materials of your own yet/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Start from a standard material'), { target: { value: 'Whiting' } });
    await user.click(screen.getByRole('button', { name: 'Copy its analysis' }));
    expect((screen.getByLabelText('Material name') as HTMLInputElement).value).toBe('Whiting');
    expect((screen.getByLabelText('Percent 1') as HTMLInputElement).value).toBe('56.03');
    expect(screen.getByTestId('material-total').textContent).toBe('100.00');
    expect(screen.getByText(/instead of the standard Whiting/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Material name'), { target: { value: 'Whiting, lot 12' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(core.called('save_record')).toHaveLength(1));
    expect(core.called('save_record')[0].args).toEqual({
      kind: 'material',
      parent: null,
      collection: null,
      content: {
        name: 'Whiting, lot 12',
        category: 'material',
        basis: 'analysis',
        oxides: [{ oxide: 'CaO', percent: '56.03' }],
        loi: '43.97',
        notes: ''
      }
    });
    expect(await screen.findByRole('button', { name: 'Whiting, lot 12' })).toBeTruthy();
  });

  it('are used by recipes', async () => {
    fakeCore({
      recipes: [{ ...shino, content: { name: 'Shino', lines: [{ material: 'spar lot 7', amount: '50' }, { material: 'Whiting', amount: '20' }], notes: '' } }],
      materials: [spar]
    });
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Shino' }));
    expect(screen.getByRole('complementary', { name: 'Unity formula' }).textContent).toContain('K₂O');
    expect(document.querySelector('#materials option[value="Spar, lot 7"]')!.getAttribute('label')).toBe('Your material');

    await user.click(screen.getByRole('button', { name: 'Materials' }));
    await user.click(screen.getByRole('button', { name: 'Spar, lot 7' }));
    expect(screen.getByRole('complementary', { name: 'Material check' }).textContent).toContain('Used inShino');
  });

  it('take the kind of the standard material they start from', async () => {
    fakeCore();
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Materials' }));
    fireEvent.change(screen.getByLabelText('Start from a standard material'), { target: { value: 'Chromium Oxide' } });
    await user.click(screen.getByRole('button', { name: 'Copy its analysis' }));
    expect((screen.getByLabelText('Kind') as HTMLSelectElement).value).toBe('colorant');
  });

  it('say when they replace a standard material by another of its names', async () => {
    fakeCore();
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Materials' }));
    fireEvent.change(screen.getByLabelText('Material name'), { target: { value: 'Quartz' } });
    expect(screen.getByRole('complementary', { name: 'Material check' }).textContent).toContain(
      'instead of the standard Silica, wherever they call it Quartz.'
    );
  });

  it('report a loss on ignition that is not a number', async () => {
    fakeCore({ materials: [spar] });
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Materials' }));
    await user.click(screen.getByRole('button', { name: 'Spar, lot 7' }));
    fireEvent.change(screen.getByLabelText('Loss on ignition'), { target: { value: '4.5%' } });
    expect(screen.getByRole('complementary', { name: 'Material check' }).textContent).toContain(
      'The loss on ignition of Spar, lot 7 is not a number.'
    );
  });

  it('show an earlier revision and make it the newest', async () => {
    const second = { ...spar, revisionId: 'material-revision-2', number: 2, content: { ...spar.content, loi: '2' } };
    const core = fakeCore({ materials: [second], history: [second, spar] });
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Materials' }));
    await user.click(screen.getByRole('button', { name: 'Spar, lot 7' }));
    await user.click(screen.getByText('Earlier revisions (1)'));
    await user.click(await screen.findByRole('button', { name: /^Revision 1 ·/ }));
    expect(core.called('record_history')[0].args).toEqual({ kind: 'material', recordId: 'material-1' });
    expect((screen.getByLabelText('Loss on ignition') as HTMLInputElement).value).toBe('0');

    await user.click(screen.getByRole('button', { name: 'Use this revision' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(core.called('save_record')).toHaveLength(1));
    expect(core.called('save_record')[0].args).toMatchObject({
      kind: 'material',
      parent: 'material-revision-2',
      content: { loi: '0' }
    });
  });

  it('can be given as a formula', async () => {
    const core = fakeCore();
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Materials' }));
    fireEvent.change(screen.getByLabelText('Material name'), { target: { value: 'Whiting, theory' } });
    await user.selectOptions(screen.getByLabelText('Given as'), 'formula');
    await user.click(screen.getByRole('button', { name: 'Add oxide' }));
    await user.click(screen.getByRole('button', { name: 'Add oxide' }));
    await user.selectOptions(screen.getByLabelText('Formula oxide 1'), 'CaO');
    await user.selectOptions(screen.getByLabelText('Formula oxide 2'), 'CO2');
    fireEvent.change(screen.getByLabelText('Moles 1'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Moles 2'), { target: { value: '1' } });
    expect(screen.getByTestId('material-total').textContent).toBe('100.09');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(core.called('save_record')).toHaveLength(1));
    expect(core.called('save_record')[0].args.content).toMatchObject({
      basis: 'formula',
      formula: [
        { oxide: 'CaO', moles: '1' },
        { oxide: 'CO2', moles: '1' }
      ]
    });
  });

  it('keep a class and a data sheet', async () => {
    const core = fakeCore();
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Materials' }));
    fireEvent.change(screen.getByLabelText('Material name'), { target: { value: 'Grolleg' } });
    await user.selectOptions(screen.getByLabelText('Class'), 'kaolin');
    fireEvent.change(screen.getByLabelText(/^Absorption/), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText(/^Fired at cone/), { target: { value: '10' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(core.called('save_record')).toHaveLength(1));
    expect(core.called('save_record')[0].args.content).toMatchObject({
      class: 'kaolin',
      sheet: { absorption: '12', cone: '10' }
    });
  });

  it('take a new name into the recipes that use them', async () => {
    const usesSpar = { ...shino, content: { ...shino.content, lines: [{ material: 'spar lot 7', amount: '50' }] } };
    const core = fakeCore({ recipes: [usesSpar], materials: [spar] });
    show();
    const user = userEvent.setup();
    // Shino is open with unsaved notes while the material is renamed.
    await user.click(await screen.findByRole('button', { name: 'Shino' }));
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Thicker' } });
    await user.click(screen.getByRole('button', { name: 'Materials' }));
    await user.click(screen.getByRole('button', { name: 'Spar, lot 7' }));
    fireEvent.change(screen.getByLabelText('Material name'), { target: { value: 'Spar, lot 8' } });
    const check = screen.getByRole('complementary', { name: 'Material check' });
    expect(check.textContent).toContain('1 recipe uses the old name, Spar, lot 7:');
    expect((screen.getByLabelText(/Also rename it in this recipe/) as HTMLInputElement).checked).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(core.called('save_record')).toHaveLength(2));
    expect(core.called('save_record')[1].args).toMatchObject({
      kind: 'recipe',
      parent: 'revision-1',
      content: { lines: [{ material: 'Spar, lot 8', amount: '50' }], notes: '' }
    });
    await user.click(screen.getByRole('button', { name: 'Materials' }));
    expect((screen.getByLabelText('Material 1') as HTMLInputElement).value).toBe('Spar, lot 8');
    expect((screen.getByLabelText('Notes') as HTMLTextAreaElement).value).toBe('Thicker');
    expect(screen.getByRole('button', { name: 'Save' }).matches(':disabled')).toBe(false);
  });

  it('cannot share a name with another of yours', async () => {
    const core = fakeCore({ materials: [spar] });
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Materials' }));
    fireEvent.change(screen.getByLabelText('Material name'), { target: { value: 'SPAR lot 7' } });
    fireEvent.change(screen.getByLabelText('Percent 1'), { target: { value: '100' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert').textContent).toBe('You already have a material called Spar, lot 7.');
    expect(core.called('save_record')).toHaveLength(0);
  });
});
