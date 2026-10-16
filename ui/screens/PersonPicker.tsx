import { useEffect, useId } from 'react';
import type { Person } from '../api';

const LAST_PERSON = 'glaze-vault last person';

/** Who is signing in to a team's vault, remembered on this computer for next time. */
export function PersonPicker({
  people,
  value,
  onChange,
  label = 'Your name'
}: {
  people: Person[];
  value: string | null;
  onChange: (id: string) => void;
  label?: string;
}) {
  const id = useId();
  useEffect(() => {
    if (value && people.some((p) => p.id === value)) return;
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_PERSON);
    } catch {
      // Storage can be off; the first name will do.
    }
    const chosen = people.find((p) => p.id === last) ?? people[0];
    if (chosen) onChange(chosen.id);
  }, [people, value]);
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value ?? ''}
        onChange={(e) => {
          onChange(e.target.value);
          rememberPerson(e.target.value);
        }}
      >
        {people.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name}
          </option>
        ))}
      </select>
    </>
  );
}

export function rememberPerson(id: string) {
  try {
    localStorage.setItem(LAST_PERSON, id);
  } catch {
    // Only a convenience.
  }
}
