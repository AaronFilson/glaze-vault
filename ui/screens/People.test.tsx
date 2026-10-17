// @vitest-environment jsdom
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Access, CustomRole, Team } from '../api';
import { People } from './Team';

afterEach(() => {
  cleanup();
  clearMocks();
});

const ALL = ['recipe', 'material', 'batch', 'firing', 'limits', 'prices'] as const;

const ACCESS: Access = {
  team: true,
  me: { id: 'ana', name: 'Ana', admin: true, mustSetPassword: false },
  collections: [{ id: 'shared', name: 'Shared', owner: null, role: 'admin', changes: [...ALL] }]
};

describe('roles an admin makes', () => {
  it('makes a role, offers it to people, and gives it', async () => {
    const roles: CustomRole[] = [];
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    const team: Team = {
      people: [
        { id: 'ana', name: 'Ana', admin: true, mustSetPassword: false },
        { id: 'ben', name: 'Ben', admin: false, mustSetPassword: false }
      ],
      grants: [{ person: 'ben', collection: 'shared', role: 'chemist' }]
    };
    mockIPC((cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args: a });
      switch (cmd) {
        case 'team':
          return team;
        case 'custom_roles':
          return roles;
        case 'create_role': {
          const role = { id: 'r1', name: a.name as string, changes: a.changes as CustomRole['changes'] };
          roles.push(role);
          return role;
        }
        default:
          return null;
      }
    });
    render(<People access={ACCESS} onChanged={() => {}} onShrunk={() => {}} />);
    const ben = (await screen.findByLabelText('Ben in Shared')) as HTMLSelectElement;
    expect([...ben.options].map((o) => o.textContent)).toContain('Tester: logs firings');

    const form = screen.getByLabelText('New role').closest('form') as HTMLElement;
    fireEvent.change(screen.getByLabelText('New role'), { target: { value: 'Costing' } });
    fireEvent.click(within(form).getByLabelText('Prices'));
    fireEvent.click(within(form).getByRole('button', { name: 'Make role' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Costing made. Give it to people above.'));
    expect(calls.find((c) => c.cmd === 'create_role')?.args).toEqual({ name: 'Costing', changes: ['prices'] });
    // The form is empty again, for the next.
    expect((screen.getByLabelText('New role') as HTMLInputElement).value).toBe('');

    const offered = [...(screen.getByLabelText('Ben in Shared') as HTMLSelectElement).options];
    const costing = offered.find((o) => o.textContent === 'Costing: changes prices')!;
    fireEvent.change(screen.getByLabelText('Ben in Shared'), { target: { value: costing.value } });
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === 'set_role')?.args).toEqual({ person: 'ben', collection: 'shared', role: 'role:r1' })
    );
  });
});
