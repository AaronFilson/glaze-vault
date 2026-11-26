// @vitest-environment jsdom
import { mockIPC } from '@tauri-apps/api/mocks';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Access, MaterialHead, RecipeHead, Revision, Settings as VaultSettings, VaultStatus } from '../api';
import { STANDARD_LIBRARY, type RecipeContent } from '../chemistry';
import { newFiring, type Firing } from '../firing';
import { BUILT_IN_LIMITS, type LimitsContent } from '../limits';
import { newMix, type Mix } from '../mix';
import { Fit } from './Fit';
import { LimitSets, LimitsPanel, limitSets } from './Limits';
import { Settings } from './Settings';

vi.setConfig({ testTimeout: 30_000 });

const SETTINGS: VaultSettings = { autoLock: true, autoLockMinutes: 25, backupReminderDays: 30, phoneBackups: true };
const STATUS: VaultStatus = {
  exists: true,
  unlocked: true,
  version: '0.2.0',
  updatesConfigured: true,
  platform: 'desktop',
  people: []
};

const sampleRecipe: RecipeHead = {
  recordId: 'r1',
  revisionId: 'r1-1',
  number: 1,
  savedAt: 1,
  collectionId: 'shared',
  content: { name: 'Celadon', lines: [{ material: 'Silica', amount: '100' }], notes: '' }
};

const sampleMaterial: MaterialHead = {
  recordId: 'm1',
  revisionId: 'm1-1',
  number: 1,
  savedAt: 1,
  collectionId: 'shared',
  content: { name: 'Local Silica', category: 'material', oxides: [{ oxide: 'SiO2', percent: '100' }], loi: '0', notes: '' }
};

const sampleFiring: Firing = {
  recordId: 'f1',
  revisionId: 'f1-1',
  number: 1,
  savedAt: 1,
  collectionId: 'shared',
  content: { ...newFiring({ recordId: 'r1', number: 1, name: 'Celadon' }, new Date(2026, 9, 10)), cone: '6' }
};

const sampleMix: Mix = {
  recordId: 'x1',
  revisionId: 'x1-1',
  number: 1,
  savedAt: 1,
  collectionId: 'shared',
  content: { ...newMix({ recipe: sampleRecipe }, new Date(2026, 9, 11)), size: '1000' }
};

describe('Settings screen decision trees', () => {
  it('handles custom auto-lock minutes, phone backup warnings, all 6 exports with audit notes, and update checks', async () => {
    const exported: string[] = [];
    const notes: unknown[] = [];
    let foundUpdate: { version: string; notes: string } | null = null;
    mockIPC((cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      if (cmd === 'set_aside_vaults') return [{ name: 'replaced-1', setAsideAt: 1000 }];
      if (cmd === 'get_preferences') return { checkForUpdates: true };
      if (cmd === 'set_preferences') return null;
      if (cmd === 'check_for_update') return foundUpdate;
      if (cmd === 'save_export') {
        exported.push(a.suggestedName as string);
        return a.suggestedName;
      }
      if (cmd === 'note') notes.push(a.note);
      return null;
    });

    const onSettings = vi.fn(async () => {});
    const onUpdate = vi.fn();
    const onInstall = vi.fn();
    render(
      <Settings
        settings={SETTINGS}
        onSettings={onSettings}
        lastBackup={null}
        phoneBackups={{
          on: true,
          last: { at: Date.UTC(2026, 9, 15), fileName: 'phone.gvbackup', photos: false, size: 4096 },
          budget: 25 * 1024 * 1024
        }}
        phoneBackupError="iCloud quota full"
        backUp={async () => {}}
        recipes={[sampleRecipe]}
        materials={[sampleMaterial]}
        firings={[sampleFiring]}
        mixes={[sampleMix]}
        status={STATUS}
        update={null}
        onUpdate={onUpdate}
        onInstall={onInstall}
        onNewRecoveryKey={() => {}}
        onSwitchVault={() => {}}
        switchError=""
        onImport={() => {}}
        onClose={() => {}}
        access={null}
        onShared={() => {}}
        onTeamChanged={() => {}}
        onLeft={() => {}}
      />
    );

    // Custom 25-minute value is preserved in Lock after select!
    const lockSelect = screen.getByLabelText('Lock after') as HTMLSelectElement;
    expect(lockSelect.value).toBe('25');
    fireEvent.change(lockSelect, { target: { value: '60' } });
    await waitFor(() => expect(onSettings).toHaveBeenCalledWith({ ...SETTINGS, autoLockMinutes: 60 }));

    // Phone backup warnings (without photos + 25 MB budget + failure alert) and toggle off.
    expect(screen.getByText(/without photos\./)).toBeTruthy();
    expect(screen.getByText(/more than the 25 MB this phone's backup takes/)).toBeTruthy();
    expect(screen.getByText(/The last backup on this phone failed: iCloud quota full/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Back up with this phone's backup"));
    await waitFor(() => expect(onSettings).toHaveBeenCalledWith({ ...SETTINGS, phoneBackups: false }));

    // Vaults set aside: open dialog and Cancel.
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to it…' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();

    // All 6 exports write files and record audit notes!
    for (const label of [
      'Export as CSV…',
      'Export as Insight XML…',
      'Export as JSON…',
      'Export materials as CSV…',
      'Export firing log as CSV…',
      'Export mix log as CSV…'
    ]) {
      fireEvent.click(screen.getByRole('button', { name: label }));
      await waitFor(() => expect(exported.length).toBeGreaterThan(0));
    }
    await waitFor(() => expect(exported).toHaveLength(6));
    expect(notes).toHaveLength(6);

    // Updates: Check now when up-to-date, then when update is available.
    const checkBtn = await screen.findByRole('button', { name: 'Check now' });
    fireEvent.click(checkBtn);
    expect(await screen.findByText('Glaze Vault 0.2.0 is the newest version.')).toBeTruthy();

    foundUpdate = { version: '0.3.0', notes: 'Clay body improvements' };
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(foundUpdate));
  });

  it('shows partial-export notice for a non-admin member and App Store / Play Store update hints on mobile', () => {
    mockIPC(() => null);
    const member: Access = {
      team: true,
      me: { id: 'ben', name: 'Ben', admin: false, mustSetPassword: false },
      collections: [
        { id: 'shared', name: 'Shared', owner: null, role: 'chemist', changes: [], export: true, print: true, chemistry: true, manage: false },
        { id: 'locked', name: 'Secret', owner: null, role: 'chemist', changes: [], export: false, print: false, chemistry: true, manage: false }
      ]
    };
    const secretRecipe = { ...sampleRecipe, recordId: 'r2', collectionId: 'locked' };
    const { rerender } = render(
      <Settings
        settings={SETTINGS}
        onSettings={async () => {}}
        lastBackup={null}
        backUp={async () => {}}
        recipes={[sampleRecipe, secretRecipe]}
        materials={[]}
        firings={[]}
        status={{ ...STATUS, updatesConfigured: false, platform: 'ios' }}
        update={null}
        onUpdate={() => {}}
        onInstall={() => {}}
        onNewRecoveryKey={() => {}}
        onSwitchVault={() => {}}
        switchError=""
        onImport={() => {}}
        onClose={() => {}}
        access={member}
        onShared={() => {}}
        onTeamChanged={() => {}}
        onLeft={() => {}}
      />
    );
    expect(screen.getByText(/An admin decides what you can see and change/)).toBeTruthy();
    expect(screen.getByText('Only the collections you may export from are in it.')).toBeTruthy();
    expect(screen.getByText(/New versions come from the App Store/)).toBeTruthy();

    rerender(
      <Settings
        settings={SETTINGS}
        onSettings={async () => {}}
        lastBackup={null}
        backUp={async () => {}}
        recipes={[]}
        materials={[]}
        firings={[]}
        status={{ ...STATUS, updatesConfigured: false, platform: 'android' }}
        update={null}
        onUpdate={() => {}}
        onInstall={() => {}}
        onNewRecoveryKey={() => {}}
        onSwitchVault={() => {}}
        switchError=""
        onImport={() => {}}
        onClose={() => {}}
        access={member}
        onShared={() => {}}
        onTeamChanged={() => {}}
        onLeft={() => {}}
      />
    );
    expect(screen.getByText(/New versions come from the Play Store/)).toBeTruthy();
    cleanup();
  });
});

describe('LimitsPanel and LimitSets decision trees', () => {
  it('shows Within and Outside limit checks, copies built-in sets, validates name, edits ranges, and deletes', async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'save_record') {
        return {
          recordId: 'lim-1',
          revisionId: 'lim-1-v1',
          number: 1,
          savedAt: 1,
          content: (args as { content: LimitsContent }).content
        };
      }
      if (cmd === 'delete_record') return { recordId: 'lim-1', revisionId: 'lim-1-v2', number: 2, savedAt: 2, deleted: true, content: {} };
      return null;
    });

    const onChoose = vi.fn();
    const { rerender } = render(
      <LimitsPanel
        sets={BUILT_IN_LIMITS}
        chosen="built-in:digitalfire-cone-6"
        onChoose={onChoose}
        umf={{ K2O: 0.2, CaO: 0.5, MgO: 0.3, Al2O3: 0.35, SiO2: 3.4 }}
      />
    );
    expect(screen.getByRole('table').textContent).toContain('Within Cone 6 (Digitalfire)');

    rerender(
      <LimitsPanel
        sets={BUILT_IN_LIMITS}
        chosen="built-in:digitalfire-cone-6"
        onChoose={onChoose}
        umf={{ K2O: 0.9, CaO: 0.1, Al2O3: 0.1, SiO2: 6.0 }}
      />
    );
    expect(screen.getByRole('table').textContent).toContain('outside Cone 6 (Digitalfire)');
    expect(screen.getByText('Below')).toBeTruthy();
    expect(screen.getAllByText('Above')).toHaveLength(2);
    cleanup();

    const onSaved = vi.fn();
    const onDeleted = vi.fn();
    let own: Revision<LimitsContent>[] = [];
    const { rerender: rerenderSets } = render(
      <LimitSets own={own} canCreate collection="shared" onSaved={(s) => { own = [s]; onSaved(s); }} onDeleted={onDeleted} />
    );

    // Copy built-in set, clear name to trigger validation error, add/remove oxide, then save!
    fireEvent.click(screen.getByRole('button', { name: 'Copy Cone 6 (Digitalfire)' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limit formula' }));
    expect(screen.getByRole('alert').textContent).toBe('Give the set a name.');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Studio Cone 6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add oxide' }));
    fireEvent.click(screen.getByLabelText('Remove oxide 1'));
    fireEvent.click(screen.getByRole('button', { name: 'Save limit formula' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));

    // Re-open saved set, test Delete -> Cancel -> Delete!
    rerenderSets(<LimitSets own={own} canCreate collection="shared" onSaved={onSaved} onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole('button', { name: 'Studio Cone 6' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('lim-1'));
    expect(calls.some(([c]) => c === 'erase_record')).toBe(true);
  });
});

describe('Fit screen remaining decision branches', () => {
  it('handles empty recipes, removing Also try lines, unchecking all May change, (use again), and Save as a new recipe', async () => {
    const empty: RecipeContent = { name: 'Blank', lines: [], notes: '' };
    const { unmount } = render(<Fit recipe={empty} library={STANDARD_LIBRARY} sets={limitSets([])} initialSet="" onClose={() => {}} />);
    expect(screen.getByText(/no unity formula to fit yet/)).toBeTruthy();
    unmount();

    const glaze: RecipeContent = {
      name: 'High Lime',
      notes: '',
      lines: [
        { material: 'Custer Spar', amount: '25' },
        { material: 'Silica', amount: '20' },
        { material: 'Whiting', amount: '35' },
        { material: 'EPK Kaolin', amount: '20' }
      ]
    };
    const onSaveNew = vi.fn(async () => {});
    render(
      <Fit
        recipe={glaze}
        library={STANDARD_LIBRARY}
        sets={BUILT_IN_LIMITS}
        initialSet="digitalfire-cone-6"
        onSaveNew={onSaveNew}
        onClose={() => {}}
      />
    );

    // Add Talc via Also try, then Remove it, then add it back.
    fireEvent.change(screen.getByLabelText('Also try'), { target: { value: 'Talc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByLabelText('Do not try Talc'));
    expect(screen.queryByLabelText('Do not try Talc')).toBeNull();

    // Unchecking every material reports a problem on Fit.
    for (const name of ['Custer Spar', 'Silica', 'Whiting', 'EPK Kaolin']) {
      fireEvent.click(screen.getByLabelText(`${name} may change`));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
    expect(screen.getByRole('alert').textContent).toBeTruthy();

    // Re-enable and fit with Talc, then Save as a new recipe -> button becomes Saved (disabled)!
    for (const name of ['Custer Spar', 'Silica', 'Whiting', 'EPK Kaolin']) {
      fireEvent.click(screen.getByLabelText(`${name} may change`));
    }
    fireEvent.change(screen.getByLabelText('Also try'), { target: { value: 'Talc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save as a new recipe' }));
    await waitFor(() => expect(onSaveNew).toHaveBeenCalledTimes(1));
    expect((screen.getByRole('button', { name: 'Saved' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
