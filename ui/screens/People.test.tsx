// @vitest-environment jsdom
import { mockIPC } from '@tauri-apps/api/mocks';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Access, Capabilities, CustomRole, Team } from '../api';
import { ManagedPeople, People } from './Team';

const ALL = ['recipe', 'material', 'batch', 'firing', 'limits', 'prices'] as const;

const ACCESS: Access = {
  team: true,
  me: { id: 'ana', name: 'Ana', admin: true, mustSetPassword: false },
  collections: [{ id: 'shared', name: 'Shared', owner: null, role: 'admin', changes: [...ALL] , export: true, print: true, chemistry: true, manage: true }]
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
          const role = { id: 'r1', name: a.name as string, changes: a.changes as CustomRole['changes'], ...(a.may as Capabilities) };
          roles.push(role);
          return role;
        }
        default:
          return null;
      }
    });
    render(<People access={ACCESS} onChanged={() => {}} onShrunk={() => {}} onOrganizationKey={() => {}} />);
    const ben = (await screen.findByLabelText('Ben in Shared')) as HTMLSelectElement;
    expect([...ben.options].map((o) => o.textContent)).toContain('Tester: logs firings');

    const form = screen.getByLabelText('New role').closest('form') as HTMLElement;
    fireEvent.change(screen.getByLabelText('New role'), { target: { value: 'Costing' } });
    fireEvent.click(within(form).getByLabelText('Prices'));
    fireEvent.click(within(form).getByRole('button', { name: 'Make role' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Costing made. Give it to people above.'));
    expect(calls.find((c) => c.cmd === 'create_role')?.args).toEqual({
      name: 'Costing',
      changes: ['prices'],
      may: { export: true, print: true, chemistry: true, manage: false }
    });
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

describe('removing an admin', () => {
  it('takes admin away first, removes them, and hands over the new organization sheet', async () => {
    const order: string[] = [];
    const team: Team = {
      people: [
        { id: 'ana', name: 'Ana', admin: true, mustSetPassword: false },
        { id: 'cy', name: 'Cy', admin: true, mustSetPassword: false }
      ],
      grants: []
    };
    mockIPC((cmd) => {
      order.push(cmd);
      switch (cmd) {
        case 'team':
          return team;
        case 'custom_roles':
          return [];
        case 'take_admin_away':
          return ['new', 'organization', 'words'];
        case 'remove_person':
          throw { code: 'io', message: 'The disk is full.' };
        default:
          return null;
      }
    });
    const onOrganizationKey = vi.fn();
    render(<People access={ACCESS} onChanged={() => {}} onShrunk={() => {}} onOrganizationKey={onOrganizationKey} />);
    const row = (await screen.findByText('Cy')).closest('tr') as HTMLElement;
    expect(within(row).getByRole('button', { name: 'Take admin away…' })).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Remove…' }));
    expect(screen.getByRole('alertdialog').textContent).toContain('Cy is an admin, so admin is taken away first');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Cy' }));
    // Removing them failed here, and the new sheet is shown all the same.
    await waitFor(() => expect(onOrganizationKey).toHaveBeenCalledWith(['new', 'organization', 'words']));
    expect(order.filter((c) => c === 'take_admin_away' || c === 'remove_person')).toEqual(['take_admin_away', 'remove_person']);
    expect(screen.getByRole('alert').textContent).toBe('The disk is full.');
    // Trying again only removes: admin is already taken away.
    fireEvent.click(screen.getByRole('button', { name: 'Remove Cy' }));
    await waitFor(() => expect(order.filter((c) => c === 'remove_person')).toHaveLength(2));
    expect(order.filter((c) => c === 'take_admin_away')).toHaveLength(1);
  });

  it('asks before replacing the organization sheet', async () => {
    const order: string[] = [];
    mockIPC((cmd) => {
      order.push(cmd);
      if (cmd === 'team') return { people: [{ id: 'ana', name: 'Ana', admin: true, mustSetPassword: false }], grants: [] };
      if (cmd === 'custom_roles') return [];
      if (cmd === 'new_organization_recovery_key') return ['fresh', 'words'];
      return null;
    });
    const onOrganizationKey = vi.fn();
    render(<People access={ACCESS} onChanged={() => {}} onShrunk={() => {}} onOrganizationKey={onOrganizationKey} />);
    fireEvent.click(await screen.findByRole('button', { name: 'New organization recovery sheet…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(order).not.toContain('new_organization_recovery_key');
    fireEvent.click(screen.getByRole('button', { name: 'New organization recovery sheet…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make a new sheet' }));
    await waitFor(() => expect(onOrganizationKey).toHaveBeenCalledWith(['fresh', 'words']));
  });

  it('keeps a role without chemistry to firings, and from managing', async () => {
    mockIPC((cmd) => (cmd === 'team' ? { people: [], grants: [] } : cmd === 'custom_roles' ? [] : null));
    render(<People access={ACCESS} onChanged={() => {}} onShrunk={() => {}} onOrganizationKey={() => {}} />);
    const editor = (await screen.findByLabelText('New role')).closest('form')!;
    const box = (name: string) => within(editor).getByLabelText(name) as HTMLInputElement;
    fireEvent.click(box('Recipes'));
    fireEvent.click(box('Manages people on its collections'));
    fireEvent.click(box('Reads recipes’ chemistry'));
    expect([box('Recipes').checked, box('Recipes').disabled]).toEqual([false, true]);
    expect(box('Firings').disabled).toBe(false);
    expect([box('Manages people on its collections').checked, box('Manages people on its collections').disabled]).toEqual([
      false,
      true
    ]);
  });
});

describe('a manager who is not an admin', () => {
  it('gives the people on their collections any role but an admin’s or a manager’s', async () => {
    const lead = { id: 'lead', name: 'Lead', changes: ['recipe'], export: true, print: true, chemistry: true, manage: true };
    const sales = { id: 'sales', name: 'Sales', changes: ['firing'], export: true, print: true, chemistry: false, manage: false };
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
      if (cmd === 'custom_roles') return [lead, sales];
      if (cmd === 'team') {
        return {
          people: [
            { id: 'ana', name: 'Ana', admin: true, mustSetPassword: false },
            { id: 'cleo', name: 'Cleo', admin: false, mustSetPassword: false },
            { id: 'ben', name: 'Ben', admin: false, mustSetPassword: false },
            { id: 'dan', name: 'Dan', admin: false, mustSetPassword: false }
          ],
          grants: [
            { person: 'cleo', collection: 'shared', role: 'role:lead' },
            { person: 'dan', collection: 'shared', role: 'role:lead' }
          ]
        };
      }
      return null;
    });
    const access: Access = {
      team: true,
      me: { id: 'cleo', name: 'Cleo', admin: false, mustSetPassword: false },
      collections: [{ ...ACCESS.collections[0], role: 'role:lead', manage: true }]
    };
    render(<ManagedPeople access={access} onChanged={() => {}} />);
    const ben = (await screen.findByLabelText('Ben in Shared')) as HTMLSelectElement;
    const offered = [...ben.options].map((o) => o.textContent);
    expect(offered).toContain('Sales: changes firings, without chemistry');
    expect(offered.some((o) => o?.startsWith('Lead'))).toBe(false);
    // Another manager's role, Ana the admin and Cleo herself are not hers to change.
    expect(screen.queryByLabelText('Dan in Shared')).toBeNull();
    expect(screen.getByText('Lead: changes recipes, manages')).toBeTruthy();
    expect(screen.queryByText('Ana')).toBeNull();
    fireEvent.change(ben, { target: { value: 'role:sales' } });
    await waitFor(() => expect(calls.some((c) => c.cmd === 'set_role')).toBe(true));
    expect(calls.find((c) => c.cmd === 'set_role')!.args).toEqual({ person: 'ben', collection: 'shared', role: 'role:sales' });
  });
});
