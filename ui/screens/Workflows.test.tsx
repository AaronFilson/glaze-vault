// @vitest-environment jsdom
import { mockIPC } from '@tauri-apps/api/mocks';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Access, Device, NetworkStatus, Person, RecipeHead } from '../api';
import { newFiring, type Firing } from '../firing';
import { newMix, type Mix } from '../mix';
import { FiringLog, type FiringEditing } from './FiringLog';
import { MixLog, type MixEditing } from './MixLog';
import { Network } from './Network';
import { People, ShareVault } from './Team';
import { fakeCore, shino, show, spar } from './recipesTestKit';

vi.setConfig({ testTimeout: 30_000 });

describe('Materials remaining decision trees', () => {
  it('copies a standard clay’s class and data sheet, handles no-oxide stains, and respects unticking rename or read-only recipes', async () => {
    const teamAccess: Access = {
      team: true,
      me: { id: 'ana', name: 'Ana', admin: false, mustSetPassword: false },
      collections: [
        { id: 'shared', name: 'Shared', owner: null, role: 'formulator', changes: ['recipe', 'material'], export: true, print: true, chemistry: true, manage: false },
        { id: 'locked', name: 'Archive', owner: null, role: 'chemist', changes: [], export: true, print: true, chemistry: true, manage: false }
      ]
    };
    const lockedRecipe: RecipeHead = {
      ...shino,
      recordId: 'r-locked',
      collectionId: 'locked',
      content: { name: 'Archived Shino', lines: [{ material: 'Spar, lot 7', amount: '50' }], notes: '' }
    };
    const sharedMat = { ...spar, collectionId: 'shared' };
    const core = fakeCore({ access: teamAccess, recipes: [lockedRecipe], materials: [sharedMat] });
    show();

    // Open Materials, copy Grolleg China Clay -> sets Class = kaolin and opens Data sheet with cone 9!
    fireEvent.click(await screen.findByRole('button', { name: 'Materials' }));
    fireEvent.change(screen.getByLabelText('Start from a standard material'), { target: { value: 'Grolleg China Clay' } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy its analysis' }));
    expect((screen.getByLabelText('Class') as HTMLSelectElement).value).toBe('kaolin');
    expect((screen.getByLabelText(/^Fired at cone/) as HTMLInputElement).value).toBe('9');

    // Remove all oxides -> shows no-oxide gum/stain hint!
    fireEvent.click(screen.getByRole('button', { name: 'New material' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    fireEvent.click(screen.getByLabelText('Remove oxide 1'));
    expect(screen.getByText(/With no oxides, this material counts in the batch/)).toBeTruthy();

    // Rename Spar, lot 7 when Archived Shino is read-only -> warns that Archived Shino still uses old name!
    fireEvent.click(screen.getByRole('button', { name: 'Spar, lot 7' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    fireEvent.change(screen.getByLabelText('Material name'), { target: { value: 'Spar, lot 9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'You may not change Archived Shino, so they still use Spar, lot 7.'
    );
    expect(core.called('save_record')).toHaveLength(1);
    cleanup();
  });
});

describe('Team ShareVault and People remaining decision trees', () => {
  it('confirms or cancels ShareVault, and handles Make admin, Take admin away, Reset password, and Add collection', async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'grow_into_team') return ['org', 'words'];
      if (cmd === 'team')
        return {
          people: [
            { id: 'ana', name: 'Ana', admin: true, mustSetPassword: false },
            { id: 'ben', name: 'Ben', admin: false, mustSetPassword: false }
          ],
          grants: []
        };
      if (cmd === 'custom_roles')
        return [{ id: 'r1', name: 'Reviewer', changes: [], export: true, print: true, chemistry: true, manage: false }];
      if (cmd === 'create_collection') return { id: 'c2', name: 'R&D', owner: null };
      return null;
    });

    const onShared = vi.fn();
    const { unmount } = render(<ShareVault onShared={onShared} />);
    expect((screen.getByRole('button', { name: 'Share this vault…' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Ana' } });
    fireEvent.click(screen.getByRole('button', { name: 'Share this vault…' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Share this vault…' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Share this vault' }));
    await waitFor(() => expect(onShared).toHaveBeenCalledWith(['org', 'words']));
    unmount();

    const adminAccess: Access = {
      team: true,
      me: { id: 'ana', name: 'Ana', admin: true, mustSetPassword: false },
      collections: [{ id: 'shared', name: 'Shared', owner: null, role: 'admin', changes: ['recipe'], export: true, print: true, chemistry: true, manage: true }]
    };
    render(<People access={adminAccess} onChanged={() => {}} onShrunk={() => {}} onOrganizationKey={() => {}} />);

    // Reset password requires >= 8 chars.
    const benRow = (await screen.findByText('Ben')).closest('tr')!;
    fireEvent.click(within(benRow).getByRole('button', { name: 'Reset password…' }));
    const resetDialog = screen.getByRole('alertdialog', { name: 'Reset password' });
    const resetConfirm = within(resetDialog).getByRole('button', { name: 'Reset password' }) as HTMLButtonElement;
    expect(resetConfirm.disabled).toBe(true);
    fireEvent.change(within(resetDialog).getByLabelText('One-time password'), { target: { value: 'temp pass 99' } });
    expect(resetConfirm.disabled).toBe(false);
    fireEvent.click(resetConfirm);
    await waitFor(() => expect(calls.some(([c]) => c === 'reset_person')).toBe(true));

    // Make admin, Add collection, Delete custom role.
    fireEvent.click(within(benRow).getByRole('button', { name: 'Make admin…' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Make admin' }));
    await waitFor(() => expect(calls.some(([c]) => c === 'make_admin')).toBe(true));

    fireEvent.change(screen.getByPlaceholderText(/New collection/), { target: { value: 'R&D' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add collection' }));
    await waitFor(() => expect(calls.some(([c]) => c === 'create_collection')).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls.some(([c]) => c === 'delete_role')).toBe(true));
    cleanup();
  });
});

describe('Network remaining decision trees', () => {
  const PEOPLE: Person[] = [
    { id: 'ana', name: 'Ana', admin: true, mustSetPassword: false },
    { id: 'ben', name: 'Ben', admin: false, mustSetPassword: false }
  ];
  const laptop: Device = { id: 'd2', name: 'Kiln Laptop', people: ['ben'], issuedAt: 1, revoked: false, lost: false };
  const netStatus: NetworkStatus = {
    replica: true,
    hostHere: false,
    hostAddress: '192.168.1.20:47917',
    canHost: true,
    defaultPort: 47917,
    device: 'd1',
    hostMovedHere: false,
    hostRetired: false
  };

  it('syncs now, toggles photos on demand, issues an extension code, retires a computer, and saves/restores host backups', async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'network_status') return netStatus;
      if (cmd === 'photos_on_demand') return false;
      if (cmd === 'sync_now') return { pulled: 2, accepted: 1, refused: 1 };
      if (cmd === 'devices') return [laptop];
      if (cmd === 'extension_code') return '7-EXT-CODE';
      if (cmd === 'revoke_device') return { devices: [{ ...laptop, revoked: true, lost: false }], passwords: [] };
      if (cmd === 'host_backups') return [];
      if (cmd === 'save_host_backup') return Date.UTC(2026, 10, 1);
      if (cmd === 'restore_host_from_file') return Date.UTC(2026, 10, 1);
      return null;
    });

    const onChanged = vi.fn();
    render(<Network people={PEOPLE} admin onChanged={onChanged} onLeft={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText('Synced: 2 received, 1 sent, 1 the host would not take.')).toBeTruthy();
    expect(onChanged).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByLabelText('Bring photos only when someone opens them'));
    await waitFor(() => expect(calls).toContainEqual(['set_photos_on_demand', { on: true }]));

    // Devices: Extension code validation (0 invalid, 7 valid) + Retire.
    fireEvent.click(screen.getByText('Show the computers paired'));
    fireEvent.click(await screen.findByRole('button', { name: 'Extension code…' }));
    fireEvent.change(screen.getByLabelText('Days'), { target: { value: '0' } });
    expect((screen.getByRole('button', { name: 'Make a code' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Days'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make a code' }));
    expect(await screen.findByText('7-EXT-CODE')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Retire…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retire it' }));
    expect(await screen.findByText(/\(retired\)/)).toBeTruthy();

    // HostBackups: Save backup + Put back a backup saved elsewhere.
    fireEvent.click(screen.getByRole('button', { name: 'Save a backup of the host…' }));
    expect(await screen.findByText(/Saved a backup of the host made/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Put back a backup saved elsewhere…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose the backup and put it back' }));
    expect(await screen.findByText(/The host is putting the backup back/)).toBeTruthy();
    cleanup();
  });
});

describe('FiringLog and MixLog PendingNotice, search, read-only, and delete flows', () => {
  const rec: RecipeHead = {
    recordId: 'r1',
    revisionId: 'r1-1',
    number: 1,
    savedAt: 1,
    collectionId: 'shared',
    content: { name: 'Celadon', lines: [{ material: 'Silica', amount: '100' }], notes: '' }
  };
  const readOnlyAccess: Access = {
    team: true,
    me: { id: 'ben', name: 'Ben', admin: false, mustSetPassword: false },
    collections: [{ id: 'shared', name: 'Shared', owner: null, role: 'chemist', changes: [], export: true, print: true, chemistry: true, manage: false }]
  };

  it('guards unsaved edits with PendingNotice, searches and deletes firings, and enforces read-only view', async () => {
    mockIPC((cmd) => {
      if (cmd === 'delete_record') return { recordId: 'f1', revisionId: 'f1-2', number: 2, savedAt: 2, deleted: true, content: {} };
      return null;
    });
    const f1: Firing = {
      recordId: 'f1',
      revisionId: 'f1-1',
      number: 1,
      savedAt: 1,
      collectionId: 'shared',
      content: { ...newFiring({ recordId: 'r1', number: 1, name: 'Celadon' }, new Date(2026, 9, 10)), cone: '10', kiln: 'Gas kiln' }
    };
    const f2: Firing = {
      recordId: 'f2',
      revisionId: 'f2-1',
      number: 1,
      savedAt: 2,
      collectionId: 'shared',
      content: { ...newFiring({ recordId: 'r1', number: 1, name: 'Celadon' }, new Date(2026, 9, 12)), cone: '6', kiln: 'Test kiln' }
    };

    const onErased = vi.fn();
    function Wrap({ access }: { access: Access | null }) {
      const [editing, setEditing] = useState<FiringEditing | null>({ current: f1, draft: f1.content });
      return (
        <FiringLog
          firings={[f1, f2]}
          mixes={[]}
          recipes={[rec]}
          access={access}
          editing={editing}
          onEdit={setEditing}
          forRecipe="r1"
          onForRecipe={() => {}}
          onSaved={() => {}}
          onErased={onErased}
        />
      );
    }

    const { unmount } = render(<Wrap access={null} />);
    // Search firings.
    fireEvent.change(screen.getByLabelText('Search firings'), { target: { value: 'Wood kiln' } });
    expect(screen.getByText('No firings here.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search firings'), { target: { value: '' } });

    // Edit notes -> try to open f2 -> PendingNotice Keep editing -> try again -> Discard changes!
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Glossy' } });
    fireEvent.click(screen.getByRole('button', { name: /2026-10-12/ }));
    expect(screen.getByRole('alertdialog', { name: 'Unsaved firing' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /2026-10-12/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect((screen.getByLabelText('Kiln') as HTMLInputElement).value).toBe('Test kiln');

    // Delete firing.
    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onErased).toHaveBeenCalledWith('f1'));
    unmount();

    // Read-only view hides Log a firing, Save, and Delete.
    render(<Wrap access={readOnlyAccess} />);
    expect(screen.getByText('You can read this firing, but not change it.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Log a firing' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete…' })).toBeNull();
    cleanup();
  });

  it('guards unsaved mix edits, removes ageing steps, deletes mixes, and enforces read-only view', async () => {
    mockIPC((cmd) => {
      if (cmd === 'delete_record') return { recordId: 'm1', revisionId: 'm1-2', number: 2, savedAt: 2, deleted: true, content: {} };
      return null;
    });
    const m1: Mix = {
      recordId: 'm1',
      revisionId: 'm1-1',
      number: 1,
      savedAt: 1,
      collectionId: 'shared',
      content: {
        ...newMix({ recipe: rec }, new Date(2026, 9, 10)),
        size: '1000',
        steps: [{ on: '2026-10-10', deflocculant: '5', water: '', gravity: '1.75', viscosity: '', gel: '' }]
      }
    };
    const m2: Mix = {
      recordId: 'm2',
      revisionId: 'm2-1',
      number: 1,
      savedAt: 2,
      collectionId: 'shared',
      content: { ...newMix({ recipe: rec }, new Date(2026, 9, 12)), size: '2000' }
    };

    const onErased = vi.fn();
    function Wrap({ access }: { access: Access | null }) {
      const [editing, setEditing] = useState<MixEditing | null>({ current: m1, draft: m1.content });
      return (
        <MixLog
          mixes={[m1, m2]}
          recipes={[rec]}
          sheets={[]}
          access={access}
          editing={editing}
          onEdit={setEditing}
          forRecipe="r1"
          onForRecipe={() => {}}
          onSaved={() => {}}
          onErased={onErased}
        />
      );
    }

    const { unmount } = render(<Wrap access={null} />);
    fireEvent.click(screen.getByLabelText('Remove step 1'));
    expect(screen.queryByLabelText('Remove step 1')).toBeNull();

    // Switching to m2 triggers PendingNotice!
    fireEvent.click(screen.getByRole('button', { name: /2026-10-12/ }));
    expect(screen.getByRole('alertdialog', { name: 'Unsaved mix' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));

    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onErased).toHaveBeenCalledWith('m1'));
    unmount();

    render(<Wrap access={readOnlyAccess} />);
    expect(screen.getByText('You can read this mix, but not change it.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Log a mix' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});
