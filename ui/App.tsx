import { useEffect, useState } from 'react';
import { api, errorText } from './api';
import { Recipes } from './screens/Recipes';
import { Recover } from './screens/Recover';
import { RecoverySheet } from './screens/RecoverySheet';
import { Setup } from './screens/Setup';
import { Unlock } from './screens/Unlock';

type Screen =
  | { name: 'loading' }
  | { name: 'failed'; message: string }
  | { name: 'setup' }
  | { name: 'recovery-sheet'; words: string[] }
  | { name: 'unlock' }
  | { name: 'recover' }
  | { name: 'open' };

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'loading' });

  useEffect(() => {
    api
      .status()
      .then((status) => setScreen(status.unlocked ? { name: 'open' } : status.exists ? { name: 'unlock' } : { name: 'setup' }))
      .catch((error) => setScreen({ name: 'failed', message: errorText(error) }));
  }, []);

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
      return <Setup onCreated={(words) => setScreen({ name: 'recovery-sheet', words })} />;
    case 'recovery-sheet':
      return <RecoverySheet words={screen.words} onDone={() => setScreen({ name: 'open' })} />;
    case 'unlock':
      return <Unlock onUnlocked={() => setScreen({ name: 'open' })} onForgot={() => setScreen({ name: 'recover' })} />;
    case 'recover':
      return <Recover onRecovered={() => setScreen({ name: 'open' })} onBack={() => setScreen({ name: 'unlock' })} />;
    case 'open':
      return <Recipes onLocked={() => setScreen({ name: 'unlock' })} />;
  }
}
