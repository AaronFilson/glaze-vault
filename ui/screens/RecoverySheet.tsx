import { useMemo, useState } from 'react';

/** Shows the recovery key once, offers to print it, then checks three of the words. */
export function RecoverySheet({ words, onDone }: { words: string[]; onDone: () => void }) {
  const [stored, setStored] = useState(false);
  const [checking, setChecking] = useState(false);
  const asked = useMemo(() => pickThree(words.length), [words]);
  const [answers, setAnswers] = useState<string[]>(['', '', '']);
  const right = asked.every((index, i) => answers[i].trim().toLowerCase() === words[index]);
  const today = new Date().toLocaleDateString(undefined, { dateStyle: 'long' });

  if (checking) {
    return (
      <main className="center">
        <form className="card" onSubmit={(e) => (e.preventDefault(), right && onDone())}>
          <h1>Check your recovery key</h1>
          <p>Type these words from your sheet, to be sure it can be read.</p>
          {asked.map((index, i) => (
            <div key={index}>
              <label htmlFor={'word' + i}>Word {index + 1}</label>
              <input
                id={'word' + i}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                autoFocus={i === 0}
                value={answers[i]}
                onChange={(e) => setAnswers(answers.map((a, j) => (j === i ? e.target.value : a)))}
              />
            </div>
          ))}
          <button type="submit" className="primary" disabled={!right}>
            Open my vault
          </button>
          <button type="button" className="link" onClick={() => setChecking(false)}>
            Show the words again
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="center">
      <section className="card wide no-print">
        <h1>Your recovery key</h1>
        <p>
          If you forget your password, these 24 words are the only way back into your vault. Nobody else can recover
          it for you, so print this page or write the words down, and keep it somewhere safe away from this computer.
        </p>
        <WordGrid words={words} />
        <div className="row">
          <button type="button" onClick={() => window.print()}>
            Print recovery sheet
          </button>
        </div>
        <label className="check">
          <input type="checkbox" checked={stored} onChange={(e) => setStored(e.target.checked)} /> I have printed or
          written down these words and put them somewhere safe.
        </label>
        <button type="button" className="primary" disabled={!stored} onClick={() => setChecking(true)}>
          Continue
        </button>
      </section>

      <section className="print-only">
        <h1>Glaze Vault recovery sheet</h1>
        <p>Made {today}.</p>
        <p>
          These 24 words open your Glaze Vault if you forget its password: choose <em>Forgot your password?</em> when
          unlocking, type the words in order, and choose a new password. The same words keep working afterwards.
        </p>
        <p>Anyone with this sheet can open your vault. Keep it somewhere safe, away from the computer.</p>
        <WordGrid words={words} />
      </section>
    </main>
  );
}

function WordGrid({ words }: { words: string[] }) {
  return (
    <ol className="words">
      {words.map((word, index) => (
        <li key={index}>
          <span className="n">{index + 1}</span> {word}
        </li>
      ))}
    </ol>
  );
}

function pickThree(count: number): number[] {
  const picked = new Set<number>();
  while (picked.size < 3) picked.add(Math.floor(Math.random() * count));
  return [...picked].sort((a, b) => a - b);
}
