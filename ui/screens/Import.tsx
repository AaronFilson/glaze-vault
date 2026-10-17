import { useMemo, useState } from 'react';
import { api, errorText, type Kind, type MaterialHead, type RecipeHead, type Revision } from '../api';
import {
  knownMaterial,
  MATERIAL_CATEGORIES,
  materialLibrary,
  sameName,
  standardNamed,
  type MaterialContent,
  type RecipeContent
} from '../chemistry';
import type { ImportPlan } from '../importFormats';

/** What to do with one item in the file. "revision" adds it after the record of the same name. */
type Choice = 'import' | 'skip' | 'revision' | 'copy';

/** The newly saved records, to put in the lists. */
export interface Imported {
  recipes: RecipeHead[];
  materials: MaterialHead[];
}

const COPY = ' (imported)';
/** Records saved at once; the progress shows after each batch. */
const BATCH = 50;

/** A file's recipes and materials, to choose from and import. */
export function Import({
  fileName,
  plan,
  recipes,
  materials,
  collection = null,
  into,
  onImported,
  onClose
}: {
  fileName: string;
  plan: ImportPlan;
  recipes: RecipeHead[];
  materials: MaterialHead[];
  /** In a team's vault, the collection new records go into, and the picker for it. */
  collection?: string | null;
  into?: React.ReactNode;
  onImported: (imported: Imported) => void;
  onClose: () => void;
}) {
  const clashOf = <Content extends { name: string }>(heads: Revision<Content>[], name: string) =>
    heads.find((head) => sameName(head.content.name, name));
  // Names in use are skipped unless the person says otherwise, and so are materials that would
  // replace a standard one in every recipe: an old program's Silica is rarely better.
  const [materialChoices, setMaterialChoices] = useState<Choice[]>(() =>
    plan.materials.map((m) => (clashOf(materials, m.name) || standardNamed(m.name) ? 'skip' : 'import'))
  );
  const [recipeChoices, setRecipeChoices] = useState<Choice[]>(() =>
    plan.recipes.map((r) => (clashOf(recipes, r.name) ? 'skip' : 'import'))
  );
  const [progress, setProgress] = useState<{ done: number; of: number } | null>(null);
  const [result, setResult] = useState<{ recipes: number; materials: number; failed: string[] } | null>(null);

  // Recipes are checked against the materials as they will be: yours, and the ones being imported.
  const library = useMemo(
    () =>
      materialLibrary([
        ...plan.materials.filter((_, i) => materialChoices[i] !== 'skip'),
        ...materials.map((m) => m.content)
      ]),
    [plan.materials, materials, materialChoices]
  );
  const unknown = (recipe: RecipeContent) =>
    [...new Set(recipe.lines.map((l) => l.material.trim()).filter((m) => m && !knownMaterial(library, m)))];

  const counts = {
    materials: materialChoices.filter((c) => c !== 'skip').length,
    recipes: recipeChoices.filter((c) => c !== 'skip').length
  };

  const run = async () => {
    const failed: string[] = [];
    const saved: Imported = { recipes: [], materials: [] };
    const total = counts.materials + counts.recipes;
    let done = 0;
    setProgress({ done, of: total });
    // Materials first, so a failure leaves no recipe looking for one.
    const save = async <Content extends { name: string }>(
      kind: Kind,
      items: Content[],
      choices: Choice[],
      heads: Revision<Content>[],
      into: Revision<Content>[]
    ) => {
      const names = heads.map((h) => h.content.name);
      const revisions: [string | null, Content][] = [];
      for (const [i, item] of items.entries()) {
        const choice = choices[i];
        if (choice === 'skip') continue;
        const clash = clashOf(heads, item.name);
        if (choice === 'revision' && clash) {
          revisions.push([clash.revisionId, { ...item, name: clash.content.name }]);
        } else {
          const name = choice === 'copy' ? freeName(item.name, names) : item.name;
          names.push(name);
          revisions.push([null, { ...item, name }]);
        }
      }
      // A batch at a time, each written to disk once. A batch that fails is tried one by one, to
      // save the rest and say which could not be saved.
      for (let at = 0; at < revisions.length; at += BATCH) {
        const batch = revisions.slice(at, at + BATCH);
        try {
          into.push(...(await api.saveRecords(kind, batch, collection)));
        } catch {
          for (const [parent, content] of batch) {
            try {
              into.push(await api.saveRecord(kind, parent, content, parent ? null : collection));
            } catch (e) {
              failed.push(`${content.name || 'Untitled'}: ${errorText(e)}`);
            }
          }
        }
        done += batch.length;
        setProgress({ done, of: total });
      }
    };
    await save('material', plan.materials, materialChoices, materials, saved.materials);
    await save('recipe', plan.recipes, recipeChoices, recipes, saved.recipes);
    onImported(saved);
    setResult({ recipes: saved.recipes.length, materials: saved.materials.length, failed });
  };

  if (result) {
    return (
      <main className="settings">
        <h1>Imported</h1>
        <p role="status">
          {result.recipes} {result.recipes === 1 ? 'recipe' : 'recipes'} and {result.materials}{' '}
          {result.materials === 1 ? 'material' : 'materials'} imported from {fileName}.
        </p>
        {result.failed.length > 0 && (
          <>
            <p className="error">These could not be imported:</p>
            <ul className="plain-list">
              {result.failed.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </>
        )}
        <button type="button" className="primary" onClick={onClose}>
          Done
        </button>
      </main>
    );
  }

  return (
    <main className="settings compare">
      <div className="settings-head">
        <h1>Import from {fileName}</h1>
        <button type="button" disabled={!!progress} onClick={onClose}>
          Cancel
        </button>
      </div>
      <p>
        Read as {plan.format}. Choose what to import: each recipe and material is added as a new one, and anything with
        the same name as one of yours is skipped unless you choose otherwise. Nothing is changed until you choose
        Import.
      </p>
      {into}
      {plan.warnings.length > 0 && (
        <details className="import-warnings">
          <summary>
            {plan.warnings.length} {plan.warnings.length === 1 ? 'note' : 'notes'} on reading the file
          </summary>
          <ul className="plain-list">
            {plan.warnings.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        </details>
      )}

      {plan.materials.length > 0 && (
        <ChoiceTable
          title="Materials"
          items={plan.materials}
          choices={materialChoices}
          onChoices={setMaterialChoices}
          clash={(item) => clashOf(materials, item.name)?.content.name}
          standard={(item) => standardNamed(item.name)}
          describe={(m: MaterialContent) =>
            [
              MATERIAL_CATEGORIES.find((c) => c.category === m.category)?.label,
              m.basis === 'formula' ? 'formula' : `${m.oxides.length} oxides`
            ].join(', ')
          }
        />
      )}
      {plan.recipes.length > 0 && (
        <ChoiceTable
          title="Recipes"
          items={plan.recipes}
          choices={recipeChoices}
          onChoices={setRecipeChoices}
          clash={(item) => clashOf(recipes, item.name)?.content.name}
          describe={(r: RecipeContent) => {
            const missing = unknown(r);
            const lines = r.lines.filter((l) => l.material.trim()).length;
            return (
              <>
                {lines} {lines === 1 ? 'material' : 'materials'}
                {missing.length > 0 && <span className="warn"> · not found: {missing.join(', ')}</span>}
              </>
            );
          }}
        />
      )}

      <div className="row">
        <button
          type="button"
          className="primary"
          disabled={!!progress || counts.materials + counts.recipes === 0}
          onClick={run}
        >
          {progress
            ? `Importing… ${progress.done} of ${progress.of}`
            : `Import ${counts.recipes} ${counts.recipes === 1 ? 'recipe' : 'recipes'} and ${counts.materials} ${
                counts.materials === 1 ? 'material' : 'materials'
              }`}
        </button>
      </div>
      <p className="hint">
        Recipes find their materials by name. A material not found is shown as unknown until you add it to your
        materials, or change the recipe to one of the standard names.
      </p>
    </main>
  );
}

function ChoiceTable<Item extends { name: string }>({
  title,
  items,
  choices,
  onChoices,
  clash,
  standard = () => null,
  describe
}: {
  title: string;
  items: Item[];
  choices: Choice[];
  onChoices: (choices: Choice[]) => void;
  clash: (item: Item) => string | undefined;
  /** The standard material an item would replace in every recipe, if any. */
  standard?: (item: Item) => string | null;
  describe: (item: Item) => React.ReactNode;
}) {
  // Only the plain ones: names in use and standard materials are each chosen on their own.
  const setAll = (choice: 'import' | 'skip') =>
    onChoices(items.map((item, i) => (clash(item) || standard(item) ? choices[i] : choice)));
  return (
    <section className="import-section">
      <div className="row">
        <h2>
          {title} ({items.length})
        </h2>
        <button type="button" className="link" onClick={() => setAll('import')}>
          Import all
        </button>
        <button type="button" className="link" onClick={() => setAll('skip')}>
          Import none
        </button>
      </div>
      <table className="compare-table">
        <tbody>
          {items.map((item, i) => {
            const yours = clash(item);
            const replaces = standard(item);
            return (
              <tr key={i}>
                <th scope="row">{item.name || 'Untitled'}</th>
                <td>{describe(item)}</td>
                <td>
                  <select
                    aria-label={`What to do with ${item.name || 'Untitled'}`}
                    value={choices[i]}
                    onChange={(e) => onChoices(choices.map((c, j) => (j === i ? (e.target.value as Choice) : c)))}
                  >
                    {yours ? (
                      <>
                        <option value="skip">Skip: you have {yours}</option>
                        <option value="revision">Add as a new revision of yours</option>
                        <option value="copy">Import as {item.name + COPY}</option>
                      </>
                    ) : replaces ? (
                      <>
                        <option value="skip">Skip: the standard {replaces} is used</option>
                        <option value="import">Import, to use instead of the standard {replaces}</option>
                      </>
                    ) : (
                      <>
                        <option value="import">Import</option>
                        <option value="skip">Skip</option>
                      </>
                    )}
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/** "Shino (imported)", or "Shino (imported 2)" when that is taken too. */
function freeName(name: string, taken: string[]): string {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name + COPY : `${name} (imported ${n})`;
    if (!taken.some((t) => sameName(t, candidate))) return candidate;
  }
}
