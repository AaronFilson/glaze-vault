// @vitest-environment jsdom
import { mockIPC } from '@tauri-apps/api/mocks';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import type { Person, VaultStatus } from '../api';
import { setPlatform } from '../printing';
import { FirstSignIn } from './FirstSignIn';
import { Recover } from './Recover';
import { RecoverySheet } from './RecoverySheet';
import { Setup } from './Setup';
import { Unlock } from './Unlock';

vi.setConfig({ testTimeout: 30_000 });

const WORDS = Array.from({ length: 24 }, (_, i) => `word${i + 1}`);

const PEOPLE: Person[] = [
  { id: 'ana', name: 'Ana', admin: true, mustSetPassword: false },
  { id: 'ben', name: 'Ben', admin: false, mustSetPassword: true }
];

const baseStatus = (fields: Partial<VaultStatus> = {}): VaultStatus => ({
  exists: false,
  unlocked: false,
  version: '0.2.0',
  updatesConfigured: false,
  platform: 'desktop',
  people: [],
  ...fields
});

describe('Setup and NewPassword decision trees', () => {
  it('validates short and mismatched passwords, toggles Show password, and handles create errors and success', async () => {
    let fail = true;
    mockIPC((cmd) => {
      if (cmd === 'create_vault') {
        if (fail) throw { code: 'io', message: 'Disk read-only' };
        return WORDS;
      }
      return null;
    });
    const onCreated = vi.fn();
    const onRestore = vi.fn();
    const onJoin = vi.fn();
    render(<Setup notice="Welcome back" onCreated={onCreated} onRestore={onRestore} onJoin={onJoin} />);

    expect(screen.getByRole('status').textContent).toBe('Welcome back');
    const create = screen.getByRole('button', { name: 'Create vault' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);

    const pass = screen.getByLabelText('Password') as HTMLInputElement;
    const again = screen.getByLabelText('Type it again') as HTMLInputElement;
    expect(pass.type).toBe('password');

    fireEvent.change(pass, { target: { value: 'short' } });
    expect(screen.getByText(/At least 8 characters\./).className).toContain('warn');
    expect(create.disabled).toBe(true);

    fireEvent.change(pass, { target: { value: 'cone six glaze' } });
    fireEvent.change(again, { target: { value: 'cone ten glaze' } });
    expect(screen.getByText('The two passwords are different.')).toBeTruthy();
    expect(again.getAttribute('aria-invalid')).toBe('true');
    expect(create.disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('Show password'));
    expect(pass.type).toBe('text');
    expect(again.type).toBe('text');

    fireEvent.change(again, { target: { value: 'cone six glaze' } });
    expect(screen.queryByText('The two passwords are different.')).toBeNull();
    expect(create.disabled).toBe(false);

    fireEvent.click(create);
    expect((await screen.findByRole('alert')).textContent).toBe('Disk read-only');

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Create vault' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(WORDS));

    fireEvent.click(screen.getByRole('button', { name: 'Restore from a backup' }));
    expect(onRestore).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Join a vault on this network' }));
    expect(onJoin).toHaveBeenCalledTimes(1);
  });

  it('offers phone backup wording when backups exist on the phone', () => {
    render(<Setup backupsOnPhone onCreated={() => {}} onRestore={() => {}} onJoin={() => {}} />);
    expect(screen.getByRole('button', { name: 'Restore from a backup on this phone' })).toBeTruthy();
  });
});

describe('RecoverySheet decision trees', () => {
  it('prints on desktop, saves PDF on phone, gates Continue, and verifies the 3 asked words', async () => {
    setPlatform('desktop');
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    const onDone = vi.fn();
    render(<RecoverySheet words={WORDS} onDone={onDone} />);

    expect(screen.getByRole('heading', { name: 'Your recovery key' })).toBeTruthy();
    const cont = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    expect(cont.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Print recovery sheet' }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    print.mockRestore();

    fireEvent.click(screen.getByLabelText(/I have printed or written down these words/));
    expect(cont.disabled).toBe(false);
    fireEvent.click(cont);

    expect(screen.getByRole('heading', { name: 'Check your recovery key' })).toBeTruthy();
    const open = screen.getByRole('button', { name: 'Open my vault' }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);

    // Can return to see the words again, then come back to check.
    fireEvent.click(screen.getByRole('button', { name: 'Show the words again' }));
    expect(screen.getByRole('heading', { name: 'Your recovery key' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    const inputs = screen.getAllByLabelText(/^Word \d+$/) as HTMLInputElement[];
    expect(inputs).toHaveLength(3);
    for (const input of inputs) {
      const label = screen.getByText((_, el) => el?.tagName === 'LABEL' && el.getAttribute('for') === input.id);
      const index = Number(label.textContent!.replace('Word ', '')) - 1;
      fireEvent.change(input, { target: { value: `  ${WORDS[index].toUpperCase()} ` } });
    }
    expect((screen.getByRole('button', { name: 'Open my vault' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Open my vault' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('shows organization wording and PDF saving/errors on phones', async () => {
    setPlatform('ios');
    let fail = true;
    mockIPC((cmd) => {
      if (cmd === 'save_pdf') {
        if (fail) throw { code: 'io', message: 'No space left' };
        return 'recovery.pdf';
      }
      return null;
    });
    render(<RecoverySheet words={WORDS} organization doneLabel="Done" onDone={() => {}} />);
    expect(screen.getByRole('heading', { name: "The organization's recovery key" })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save recovery sheet as PDF…' }));
    expect((await screen.findByRole('alert')).textContent).toBe('No space left');

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Save recovery sheet as PDF…' }));
    expect(await screen.findByText(/Saved as recovery\.pdf\./)).toBeTruthy();
    setPlatform('desktop');
  });
});

describe('Unlock, FirstSignIn, and Recover decision trees', () => {
  it('picks a team member, remembers them, shows wrong-password errors, and routes links', async () => {
    const calls: unknown[] = [];
    let fail = true;
    mockIPC((cmd, args) => {
      if (cmd === 'unlock') {
        calls.push(args);
        if (fail) throw { code: 'wrong-password', message: 'That password is not right.' };
      }
      return null;
    });
    const onUnlocked = vi.fn();
    const onForgot = vi.fn();
    const onRestore = vi.fn();
    render(
      <Unlock
        people={PEOPLE}
        notice="The vault locked because nobody was using it."
        onUnlocked={onUnlocked}
        onForgot={onForgot}
        onRestore={onRestore}
      />
    );
    expect(screen.getByRole('status').textContent).toContain('nobody was using it');
    const unlockBtn = screen.getByRole('button', { name: 'Unlock' }) as HTMLButtonElement;
    expect(unlockBtn.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'ben' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong pass' } });
    fireEvent.click(unlockBtn);
    expect((await screen.findByRole('alert')).textContent).toBe('That password is not right.');

    fail = false;
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'right password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
    expect(calls.at(-1)).toEqual({ person: 'ben', password: 'right password' });

    fireEvent.click(screen.getByRole('button', { name: 'Forgot your password?' }));
    expect(onForgot).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Restore from a backup' }));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it('sets a new member’s own password on FirstSignIn, handling errors', async () => {
    let fail = true;
    mockIPC((cmd) => {
      if (cmd === 'set_own_password') {
        if (fail) throw { code: 'io', message: 'Could not write keyring' };
        return WORDS;
      }
      return null;
    });
    const onDone = vi.fn();
    render(<FirstSignIn name="Ben" onDone={onDone} />);
    expect(screen.getByRole('heading', { name: 'Welcome, Ben' })).toBeTruthy();
    const submit = screen.getByRole('button', { name: 'Set my password' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'bens own secret' } });
    fireEvent.change(screen.getByLabelText('Type it again'), { target: { value: 'bens own secret' } });
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);
    expect((await screen.findByRole('alert')).textContent).toBe('Could not write keyring');

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Set my password' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(WORDS));
  });

  it('counts recovery words, toggles personal vs organization recovery, filters admins, and goes back', async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'recover') throw { code: 'wrong-recovery', message: 'That recovery key is not right.' };
      if (cmd === 'recover_organization') return WORDS;
      return null;
    });
    const onRecovered = vi.fn();
    const onBack = vi.fn();
    render(<Recover people={PEOPLE} onRecovered={onRecovered} onBack={onBack} />);

    expect(screen.getByText('0 of 24 words')).toBeTruthy();
    const submit = screen.getByRole('button', { name: 'Set password and unlock' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Recovery words'), { target: { value: WORDS.slice(0, 5).join(' ') } });
    expect(screen.getByText('5 of 24 words')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'fresh pass 123' } });
    fireEvent.change(screen.getByLabelText('Type it again'), { target: { value: 'fresh pass 123' } });
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Recovery words'), { target: { value: WORDS.join(' ') } });
    expect(screen.getByText('24 of 24 words')).toBeTruthy();
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);
    expect((await screen.findByRole('alert')).textContent).toBe('That recovery key is not right.');

    // Toggle to organization recovery: only admins (Ana, not Ben) appear in Admin select.
    fireEvent.click(screen.getByRole('button', { name: "Use the organization's recovery key" }));
    expect(screen.getByRole('heading', { name: "Use the organization's recovery key" })).toBeTruthy();
    const adminSelect = screen.getByLabelText('Admin') as HTMLSelectElement;
    expect([...adminSelect.options].map((o) => o.textContent)).toEqual(['Ana']);

    fireEvent.click(screen.getByRole('button', { name: 'Set password and unlock' }));
    await waitFor(() => expect(onRecovered).toHaveBeenCalledWith(WORDS));
    expect(calls).toContainEqual([
      'recover_organization',
      { admin: 'ana', words: WORDS.join(' '), newPassword: 'fresh pass 123' }
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Use your own recovery key instead' }));
    expect(screen.getByRole('heading', { name: 'Use your recovery key' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('App top-level routing and events', () => {
  it('shows startup failure when vault_status rejects', async () => {
    mockIPC((cmd) => {
      if (cmd === 'vault_status') throw { code: 'corrupt', message: 'The key file is damaged.' };
      return null;
    });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Glaze Vault could not start' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('The key file is damaged.');
  });

  it('routes setup -> join -> back -> restore -> back, and handles vault-removed event', async () => {
    let removedHandler: number | null = null;
    mockIPC((cmd, args) => {
      if (cmd === 'vault_status') return baseStatus({ platform: 'ios' });
      if (cmd === 'phone_backups') return [{ path: '/b.gvbackup', fileName: 'b.gvbackup', createdAt: 1, appVersion: '0.2.0', admins: [], photos: true }];
      if (cmd === 'prepare_join') return { fingerprint: '1111-2222', suggestedName: 'iPhone' };
      if (cmd === 'discover_hosts') return [];
      if (cmd === 'plugin:event|listen' && (args as { event: string }).event === 'vault-removed') {
        removedHandler = (args as { handler: number }).handler;
        return 1;
      }
      return null;
    });
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Restore from a backup on this phone' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Join a vault on this network' }));
    expect(await screen.findByText('1111-2222')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { name: 'Set up your vault' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Restore from a backup on this phone' }));
    expect(await screen.findByRole('heading', { name: 'Restore from a backup' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { name: 'Set up your vault' })).toBeTruthy();

    // Simulate admin revoking this device while open/on screen.
    act(() => {
      (window as unknown as { __TAURI_INTERNALS__: { runCallback: (id: number, data: unknown) => void } })
        .__TAURI_INTERNALS__.runCallback(removedHandler!, { event: 'vault-removed', id: 1, payload: null });
    });
    expect(await screen.findByText(/An admin took this computer out of the vault/)).toBeTruthy();
    cleanup();
    setPlatform('desktop');
  });

  it('routes an unlocked new team member straight to FirstSignIn, and checks updates when configured', async () => {
    let checked = false;
    mockIPC((cmd) => {
      if (cmd === 'vault_status') return baseStatus({ exists: true, unlocked: true, updatesConfigured: true, people: PEOPLE });
      if (cmd === 'my_access') return { team: true, me: PEOPLE[1], collections: [] };
      if (cmd === 'get_preferences') return { checkForUpdates: true };
      if (cmd === 'check_for_update') {
        checked = true;
        return { version: '0.3.0', notes: 'Faster sync' };
      }
      return null;
    });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Welcome, Ben' })).toBeTruthy();
    await waitFor(() => expect(checked).toBe(true));
  });
});
