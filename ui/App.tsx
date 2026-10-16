import { useEffect, useState } from 'react';
import { api, errorText, type UpdateInfo, type VaultStatus } from './api';
import { Recipes, type LockReason } from './screens/Recipes';
import { Recover } from './screens/Recover';
import { RecoverySheet } from './screens/RecoverySheet';
import { Restore, Restored, type RestoreResult } from './screens/Restore';
import { Setup } from './screens/Setup';
import { Unlock } from './screens/Unlock';

type Screen =
  | { name: 'loading' }
  | { name: 'failed'; message: string }
  | { name: 'setup' }
  | { name: 'recovery-sheet'; words: string[] }
  | { name: 'unlock'; notice?: string }
  | { name: 'recover' }
  | { name: 'restore'; back: 'setup' | 'unlock' }
  | { name: 'restored'; result: RestoreResult }
  | { name: 'open' };

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'loading' });
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    api
      .status()
      .then((status) => {
        setStatus(status);
        setScreen(status.unlocked ? { name: 'open' } : status.exists ? { name: 'unlock' } : { name: 'setup' });
        // A quiet check at start: offline computers simply hear nothing.
        if (status.updatesConfigured) {
          api
            .preferences()
            .then((preferences) => (preferences.checkForUpdates ? api.checkForUpdate() : null))
            .then(setUpdate, () => {});
        }
      })
      .catch((error) => setScreen({ name: 'failed', message: errorText(error) }));
  }, []);

  const locked = (reason: LockReason) =>
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
          onCreated={(words) => setScreen({ name: 'recovery-sheet', words })}
          onRestore={() => setScreen({ name: 'restore', back: 'setup' })}
        />
      );
    case 'recovery-sheet':
      return <RecoverySheet words={screen.words} onDone={() => setScreen({ name: 'open' })} />;
    case 'unlock':
      return (
        <Unlock
          notice={screen.notice}
          onUnlocked={() => setScreen({ name: 'open' })}
          onForgot={() => setScreen({ name: 'recover' })}
          onRestore={() => setScreen({ name: 'restore', back: 'unlock' })}
        />
      );
    case 'recover':
      return <Recover onRecovered={() => setScreen({ name: 'open' })} onBack={() => setScreen({ name: 'unlock' })} />;
    case 'restore':
      return (
        <Restore
          vaultExists={screen.back === 'unlock'}
          onRestored={(result) => setScreen({ name: 'restored', result })}
          onBack={() => setScreen(screen.back === 'setup' ? { name: 'setup' } : { name: 'unlock' })}
        />
      );
    case 'restored':
      return <Restored result={screen.result} onDone={() => setScreen({ name: 'open' })} />;
    case 'open':
      return status && <Recipes status={status} update={update} onUpdate={setUpdate} onLocked={locked} />;
  }
}
