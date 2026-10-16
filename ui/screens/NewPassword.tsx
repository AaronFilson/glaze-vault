import { useId, useState } from 'react';
import { MIN_PASSWORD_CHARS } from '../api';

/** Two password fields that must match. Reports the password once it is acceptable, else null. */
export function NewPassword({
  label,
  onChange,
  autoFocus = true
}: {
  label: string;
  onChange: (password: string | null) => void;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [shown, setShown] = useState(false);

  const update = (a: string, b: string) => {
    setFirst(a);
    setSecond(b);
    onChange([...a].length >= MIN_PASSWORD_CHARS && a === b ? a : null);
  };
  const tooShort = first.length > 0 && [...first].length < MIN_PASSWORD_CHARS;
  const mismatch = second.length > 0 && first !== second;

  return (
    <>
      <label htmlFor={id + 'a'}>{label}</label>
      <input
        id={id + 'a'}
        type={shown ? 'text' : 'password'}
        data-secret
        autoComplete="new-password"
        autoFocus={autoFocus}
        value={first}
        onChange={(e) => update(e.target.value, second)}
        aria-describedby={id + 'hint'}
      />
      <p id={id + 'hint'} className={tooShort ? 'hint warn' : 'hint'}>
        At least {MIN_PASSWORD_CHARS} characters. A few unrelated words are easy to remember and hard to guess.
      </p>
      <label htmlFor={id + 'b'}>Type it again</label>
      <input
        id={id + 'b'}
        type={shown ? 'text' : 'password'}
        data-secret
        autoComplete="new-password"
        value={second}
        onChange={(e) => update(first, e.target.value)}
        aria-invalid={mismatch}
      />
      {mismatch && <p className="hint warn">The two passwords are different.</p>}
      <label className="check">
        <input type="checkbox" checked={shown} onChange={(e) => setShown(e.target.checked)} /> Show password
      </label>
    </>
  );
}
