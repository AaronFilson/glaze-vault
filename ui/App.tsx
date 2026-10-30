import { useEffect, useState } from 'react';
import { api, errorText, onEvent, type Person, type UpdateInfo, type VaultStatus } from './api';
import { FirstSignIn } from './screens/FirstSignIn';
import { Join } from './screens/Join';
import { Recipes, type LockReason } from './screens/Recipes';
import { Recover } from './screens/Recover';
import { RecoverySheet } from './screens/RecoverySheet';
import { Restore, Restored, type RestoreResult } from './screens/Restore';
import { Setup } from './screens/Setup';
import { Unlock } from './screens/Unlock';

type Screen =
  | { name: 'loading' }
  | { name: 'failed'; message: string }
  | { name: 'setup'; notice?: string }
  | { name: 'join' }
  /** A recovery key to show once, the organization's or a person's. */
  | { name: 'recovery-sheet'; words: string[]; organization?: boolean }
  | { name: 'first-sign-in'; person: Person }
  | { name: 'unlock'; notice?: string }
  | { name: 'recover' }
  | { name: 'restore'; back: 'setup' | 'unlock' }
  | { name: 'restored'; result: RestoreResult }
  | { name: 'open' };

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'loading' });
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  // The people on the lock screen change as a team does, so the status is read again on locking.
  const refreshStatus = () => api.status().then(setStatus, () => {});

  /** Once unlocked: someone an admin added chooses their own password first. */
  const opened = async () => {
    try {
      const access = await api.access();
      setScreen(access.me.mustSetPassword ? { name: 'first-sign-in', person: access.me } : { name: 'open' });
    } catch {
      setScreen({ name: 'open' });
    }
  };

  useEffect(() => {
    api
      .status()
      .then((status) => {
        setStatus(status);
        if (status.unlocked) void opened();
        else setScreen(status.exists ? { name: 'unlock' } : { name: 'setup' });
        // A quiet check at start: offline computers simply hear nothing.
        if (status.updatesConfigured) {
          api
            .preferences()
            .then((preferences) => (preferences.checkForUpdates ? api.checkForUpdate() : null))
            .then(setUpdate, () => {});
        }
      })
      .catch((error) => setScreen({ name: 'failed', message: errorText(error) }));
    // An admin revoked this computer, and its copy of the vault is gone (ADR 24).
    return onEvent<string | null>('vault-removed', () => {
      void refreshStatus();
      setScreen({
        name: 'setup',
        notice:
          'An admin took this computer out of the vault, so its copy was removed. Everything that reached the host is still there.'
      });
    });
  }, []);

  const locked = (reason: LockReason) => {
    void refreshStatus();
    if (reason === 'left') {
      setScreen({ name: 'setup' });
      return;
    }
    setScreen({
      name: 'unlock',
      notice:
        reason === 'idle-with-draft'
          ? 'The vault locked because nobody was using it. Your unsaved changes were kept and will come back when you unlock.'
          : reason === 'idle'
            ? 'The vault locked because nobody was using it.'
            : reason === 'switched'
              ? 'This is the vault you switched to: unlock it with its own password. The one you had open is set aside, and you can switch back to it in Settings.'
              : undefined
    });
  };

  switch (screen.name) {
    case 'loading':
      return null;
    case 'failed':
      return (
        <main className="center">
          <h1>Glaze Vault could not start</h1>
          <p role="alert">{screen.message}</p>
        </main>
      );
    case 'setup':
      return (
        <Setup
          notice={screen.notice}
          onCreated={(words) => setScreen({ name: 'recovery-sheet', words })}
          onRestore={() => setScreen({ name: 'restore', back: 'setup' })}
          onJoin={() => setScreen({ name: 'join' })}
        />
      );
    case 'join':
      return (
        <Join
          onJoined={() => {
            void refreshStatus();
            setScreen({
              name: 'unlock',
              notice: 'This computer has joined the vault. Sign in with your own password: what you may see comes from the host.'
            });
          }}
          onBack={() => setScreen({ name: 'setup' })}
        />
      );
    case 'recovery-sheet':
      return (
        <RecoverySheet
          words={screen.words}
          organization={screen.organization}
          onDone={() => setScreen({ name: 'open' })}
        />
      );
    case 'first-sign-in':
      return (
        <FirstSignIn
          name={screen.person.name}
          onDone={(words) => setScreen({ name: 'recovery-sheet', words })}
        />
      );
    case 'unlock':
      return (
        <Unlock
          people={status?.people ?? []}
          notice={screen.notice}
          onUnlocked={() => void opened()}
          onForgot={() => setScreen({ name: 'recover' })}
          onRestore={() => setScreen({ name: 'restore', back: 'unlock' })}
        />
      );
    case 'recover':
      return (
        <Recover
          people={status?.people ?? []}
          onRecovered={(words) => (words ? setScreen({ name: 'recovery-sheet', words }) : void opened())}
          onBack={() => setScreen({ name: 'unlock' })}
        />
      );
    case 'restore':
      return (
        <Restore
          vaultExists={screen.back === 'unlock'}
          onRestored={(result) => setScreen({ name: 'restored', result })}
          onBack={() => setScreen(screen.back === 'setup' ? { name: 'setup' } : { name: 'unlock' })}
        />
      );
    case 'restored':
      return (
        <Restored
          result={screen.result}
          onDone={() => {
            void refreshStatus();
            const words = screen.result.recoveryWords;
            if (words) setScreen({ name: 'recovery-sheet', words });
            else void opened();
          }}
        />
      );
    case 'open':
      return status && <Recipes status={status} update={update} onUpdate={setUpdate} onLocked={locked} />;
  }
}
