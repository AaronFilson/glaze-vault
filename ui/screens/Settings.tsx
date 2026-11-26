import { useState } from 'react';
import type {
  Access,
  LastBackup,
  MaterialHead,
  PhoneBackups,
  RecipeHead,
  Settings as VaultSettings,
  UpdateInfo,
  VaultStatus
} from '../api';
import type { Firing } from '../firing';
import type { ImportPlan } from '../importFormats';
import type { Mix } from '../mix';
import { offered as offeredOn, type Offered } from '../phone';
import { editableCollections, may } from '../team';
import { AuditLog } from './AuditLog';
import { Network } from './Network';
import { AutoLock, Backups, Section, SetAsideVaults } from './SettingsBackups';
import { ChangePassword, ExportSection, ImportSection, RecoveryKey, Updates } from './SettingsTransfer';
import { ManagedPeople, People, ShareVault } from './Team';

/** Everything, as on a computer. */
const OFFERED_EVERYWHERE = offeredOn('desktop', false);

export function Settings({
  settings,
  onSettings,
  lastBackup,
  phoneBackups = null,
  phoneBackupError = '',
  backUp,
  recipes,
  materials,
  firings,
  mixes = [],
  status,
  update,
  onUpdate,
  onInstall,
  onNewRecoveryKey,
  onSwitchVault,
  switchError,
  onImport,
  onClose,
  access,
  onShared,
  onTeamChanged,
  onLeft,
  limitFormulas,
  prices,
  offered = OFFERED_EVERYWHERE
}: {
  settings: VaultSettings;
  onSettings: (settings: VaultSettings) => Promise<void>;
  lastBackup: LastBackup | null;
  /** A phone's own vault's backups; null on a desktop and on a computer that syncs. */
  phoneBackups?: PhoneBackups | null;
  phoneBackupError?: string;
  backUp: () => Promise<void>;
  recipes: RecipeHead[];
  materials: MaterialHead[];
  firings: Firing[];
  /** The mix log, for its export. */
  mixes?: Mix[];
  status: VaultStatus;
  update: UpdateInfo | null;
  onUpdate: (update: UpdateInfo | null) => void;
  onInstall: () => void;
  onNewRecoveryKey: (words: string[]) => void;
  /** Swaps this vault with one a restore set aside, and locks. */
  onSwitchVault: (name: string) => void;
  switchError: string;
  /** Shows what a file holds, to choose what to import. */
  onImport: (fileName: string, plan: ImportPlan) => void;
  onClose: () => void;
  /** Who is signed in, and whether the vault is a team's (ADR 12). */
  access: Access | null;
  /** The vault was shared: shows the organization's recovery key. */
  onShared: (organizationWords: string[]) => void;
  /** People or collections changed: reads this person's access again. */
  onTeamChanged: () => void;
  /** What this platform offers: a phone that joined a host leaves running the vault to a computer. */
  offered?: Offered;
  /** This computer left the vault it synced. */
  onLeft: () => void;
  /** The person's own limit formulas (Limits.tsx). */
  limitFormulas?: React.ReactNode;
  /** The price list (Prices.tsx). */
  prices?: React.ReactNode;
}) {
  const [shrunkTo, setShrunkTo] = useState<string | null>(null);
  // In a team's vault, backups and switching vaults change everyone's, so they are for admins.
  const team = !!access?.team;
  const admin = !team || !!access?.me.admin;
  /** What this person may export: the records in collections whose role lets them. */
  const exportable = <Item extends { collectionId?: string }>(list: Item[]) =>
    list.filter((item) => may(access, item.collectionId, 'export'));
  return (
    <main className="settings">
      <div className="settings-head">
        <h1>Settings</h1>
        <button type="button" onClick={onClose}>
          Back to recipes
        </button>
      </div>
      {access && (
        <Section title={team ? 'People' : 'Sharing'}>
          {shrunkTo && !team && (
            <p className="hint" role="status">
              This vault is yours alone again. The backup made first is {shrunkTo}.
            </p>
          )}
          {!offered.team ? (
            <p>
              {team ? (
                <>
                  You are signed in as <strong>{access.me.name}</strong>.{' '}
                </>
              ) : null}
              People, roles and sharing are looked after on a computer.
            </p>
          ) : !team ? (
            <ShareVault onShared={onShared} />
          ) : access.me.admin ? (
            <People
              access={access}
              onOrganizationKey={onShared}
              onChanged={onTeamChanged}
              onShrunk={(backup) => {
                setShrunkTo(backup);
                onTeamChanged();
              }}
            />
          ) : access.collections.some((c) => c.manage) ? (
            <ManagedPeople access={access} onChanged={onTeamChanged} />
          ) : (
            <p>
              You are signed in as <strong>{access.me.name}</strong>. An admin decides what you can see and change, and
              backs up the vault.
            </p>
          )}
        </Section>
      )}
      {limitFormulas && <Section title="Limit formulas">{limitFormulas}</Section>}
      {prices && <Section title="Prices">{prices}</Section>}
      <AutoLock settings={settings} onSettings={onSettings} />
      {admin && offered.backups && (
        <Backups
          settings={settings}
          onSettings={onSettings}
          lastBackup={lastBackup}
          phoneBackups={phoneBackups}
          phoneBackupError={phoneBackupError}
          backUp={backUp}
        />
      )}
      {admin && offered.backups && <SetAsideVaults onSwitch={onSwitchVault} error={switchError} />}
      {offered.import &&
        (!team || editableCollections(access, 'recipe').length > 0 || editableCollections(access, 'material').length > 0) && (
        <ImportSection onImport={onImport} />
      )}
      {(!team || access?.collections.some((c) => c.export)) && (
        <ExportSection
          recipes={exportable(recipes)}
          materials={exportable(materials)}
          firings={exportable(firings)}
          mixes={exportable(mixes)}
          version={status.version}
          partly={[recipes, materials, firings, mixes].some((list) => exportable<{ collectionId?: string }>(list).length < list.length)}
        />
      )}
      {team && (
        <Section title="Network">
          <Network
            people={status.people}
            admin={admin}
            phone={status.platform !== 'desktop'}
            onChanged={onTeamChanged}
            onLeft={onLeft}
          />
        </Section>
      )}
      {admin && access && offered.auditLog && (
        <Section title="Audit log">
          <AuditLog access={access} people={status.people} records={recordNames(recipes, materials, firings)} />
        </Section>
      )}
      <ChangePassword />
      <RecoveryKey onNewRecoveryKey={onNewRecoveryKey} />
      <Updates status={status} update={update} onUpdate={onUpdate} onInstall={onInstall} />
    </main>
  );
}

/** What the audit log calls the records this person can open. */
function recordNames(recipes: RecipeHead[], materials: MaterialHead[], firings: Firing[]): Record<string, string> {
  return Object.fromEntries([
    ...recipes.map((r) => [r.recordId, r.content.name] as const),
    ...materials.map((m) => [m.recordId, m.content.name] as const),
    ...firings.map((f) => [f.recordId, `${f.content.recipeName} fired ${f.content.firedOn}`] as const)
  ]);
}
