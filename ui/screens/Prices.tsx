// The price list, in Settings, and a recipe's cost below its unity formula
// (docs/adr/0015-chemistry-tools.md).
import { useId, useState } from 'react';
import { api, errorText, type Access, type Revision } from '../api';
import type { MaterialLibrary, RecipeLine } from '../chemistry';
import { EMPTY_PRICES, money, recipeCost, type PricesContent } from '../prices';
import { canEdit, collectionLabel, editableCollections } from '../team';
import { ForkChoice } from './ForkChoice';
import { CheckoutBar } from './CheckoutBar';

/** What the recipe costs, from the price list, if it has prices for any of it. */
export function CostLine({ lines, list }: { lines: RecipeLine[]; list: PricesContent | null }) {
  const cost = recipeCost(lines, list);
  if (!cost || !list) return null;
  return (
    <p className="cost">
      Costs {money(cost.perUnit, list)} per {list.unit} dry
      {cost.missing.length > 0 && <span className="hint"> without {cost.missing.join(', ')}, which have no price</span>}
    </p>
  );
}

/** Settings: the price lists. A one-person vault has one; in a team's, each collection may have
 * its own, and a recipe is costed by its collection's, or the newest the person can open. */
export function PriceLists({
  lists,
  access,
  names,
  library,
  onSaved
}: {
  lists: Revision<PricesContent>[];
  access: Access | null;
  names: Record<string, string>;
  library: MaterialLibrary;
  onSaved: (saved: Revision<PricesContent>) => void;
}) {
  const id = useId();
  // Collections whose prices this person may read: not those where they only weigh batches.
  const readable = (access?.collections ?? []).filter((c) => c.role !== 'operator');
  const [chosen, setChosen] = useState<string | null>(
    () =>
      lists.find((l) => readable.some((c) => c.id === l.collectionId))?.collectionId ??
      editableCollections(access, 'prices').find((c) => !c.owner)?.id ??
      readable[0]?.id ??
      null
  );
  if (!access?.team) {
    const list = lists[0] ?? null;
    return <PriceList list={list} library={library} canEdit collection={null} onSaved={onSaved} />;
  }
  const list = lists.find((l) => l.collectionId === chosen) ?? null;
  const editable = canEdit(access, chosen, 'prices');
  return (
    <>
      <div className="row">
        <label htmlFor={id}>Prices for</label>
        <select id={id} value={chosen ?? ''} onChange={(e) => setChosen(e.target.value)}>
          {readable.map((collection) => (
            <option key={collection.id} value={collection.id}>
              {collectionLabel(collection, access, names)}
              {lists.some((l) => l.collectionId === collection.id) ? '' : ' (no prices yet)'}
            </option>
          ))}
        </select>
      </div>
      <p className="hint">
        A recipe is costed by its own collection’s prices, or, where that has none, by the newest list you can open.
      </p>
      {list || editable ? (
        <PriceList
          key={chosen ?? 'none'}
          list={list}
          library={library}
          canEdit={editable}
          collection={chosen}
          onSaved={onSaved}
        />
      ) : (
        <p className="hint">This collection has no prices of its own.</p>
      )}
    </>
  );
}

/** What each material costs, in one list. */
export function PriceList({
  list,
  library,
  canEdit,
  collection,
  onSaved
}: {
  list: Revision<PricesContent> | null;
  library: MaterialLibrary;
  canEdit: boolean;
  /** Where a new list goes, in a team's vault. */
  collection: string | null;
  onSaved: (saved: Revision<PricesContent>) => void;
}) {
  const [draft, setDraft] = useState<PricesContent>(() => withEmptyLine(list?.content ?? EMPTY_PRICES));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const setLine = (index: number, change: Partial<PricesContent['prices'][number]>) =>
    setDraft((now) => withEmptyLine({ ...now, prices: now.prices.map((p, i) => (i === index ? { ...p, ...change } : p)) }));

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const content = { ...draft, prices: draft.prices.filter((p) => p.material.trim() && p.price.trim()) };
      const saved = list
        ? await api.saveRecord<PricesContent>('prices', list.revisionId, content)
        : await api.saveRecord<PricesContent>('prices', null, content, collection);
      onSaved(saved);
      setMessage('Prices saved.');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save}>
      {list && (
        <ForkChoice
          kind="prices"
          head={list}
          name="These prices"
          readOnly={!canEdit}
          onResolved={(saved) => {
            setDraft(withEmptyLine(saved.content));
            onSaved(saved);
          }}
        />
      )}
      {list && <CheckoutBar kind="prices" record={list.recordId} readOnly={!canEdit} />}
      <p className="hint">
        What each material costs you, dry, so each recipe shows what it costs below its unity formula.
      </p>
      <fieldset className="plain" disabled={!canEdit}>
        <div className="row">
          <label htmlFor="prices-currency">Currency</label>
          <input
            id="prices-currency"
            className="short"
            value={draft.currency}
            onChange={(e) => setDraft({ ...draft, currency: e.target.value })}
          />
          <label htmlFor="prices-unit">Price per</label>
          <select
            id="prices-unit"
            value={draft.unit}
            onChange={(e) => setDraft({ ...draft, unit: e.target.value as 'kg' | 'lb' })}
          >
            <option value="kg">kilogram</option>
            <option value="lb">pound</option>
          </select>
        </div>
        <table className="lines">
          <thead>
            <tr>
              <th scope="col">Material</th>
              <th scope="col" className="num">
                Price
              </th>
            </tr>
          </thead>
          <tbody>
            {draft.prices.map((line, i) => (
              <tr key={i}>
                <td>
                  <input
                    aria-label={`Priced material ${i + 1}`}
                    list="price-materials"
                    value={line.material}
                    onChange={(e) => setLine(i, { material: e.target.value })}
                  />
                </td>
                <td className="num">
                  <input
                    aria-label={`Price ${i + 1}`}
                    inputMode="decimal"
                    value={line.price}
                    onChange={(e) => setLine(i, { price: e.target.value })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <datalist id="price-materials">
          {library.names.map(({ name }) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </fieldset>
      {canEdit && (
        <div className="row">
          <button type="submit" className="primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save prices'}
          </button>
          {message && (
            <span className="hint" role="status">
              {message}
            </span>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  );
}

/** A list always ends in an empty line to type the next price in. */
function withEmptyLine(list: PricesContent): PricesContent {
  const last = list.prices[list.prices.length - 1];
  return last && !last.material && !last.price ? list : { ...list, prices: [...list.prices, { material: '', price: '' }] };
}
