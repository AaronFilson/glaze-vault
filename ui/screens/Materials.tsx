import { useMemo, useState } from 'react';
import type { MaterialHead, RecipeHead } from '../api';
import {
  checkMaterial,
  FORMULA_PARTS,
  MATERIAL_CATEGORIES,
  MATERIAL_NAMES,
  normalize,
  OXIDES,
  oxideLabel,
  sameName,
  standardAnalysis,
  standardNamed,
  type FormulaLine,
  type MaterialCheck,
  type MaterialContent,
  type OxideLine
} from '../chemistry';
import { hasSheet, isClay, MATERIAL_CLASSES, SHEET_FIELDS, tidySheet, type DataSheet, type MaterialClass } from '../materialData';
import type { Editor } from '../useEditor';
import { DeletedList, DeletedNotice } from './Deleted';
import { RevisionHistory, ViewingNotice } from './RevisionHistory';

export const EMPTY_MATERIAL: MaterialContent = {
  name: '',
  category: 'material',
  oxides: [{ oxide: 'SiO2', percent: '' }],
  loi: '',
  notes: ''
};

export function sameMaterial(a: MaterialContent, b: MaterialContent): boolean {
  return (
    a.name === b.name &&
    a.category === b.category &&
    (a.basis ?? 'analysis') === (b.basis ?? 'analysis') &&
    a.loi === b.loi &&
    a.notes === b.notes &&
    a.class === b.class &&
    sameSheet(a.sheet, b.sheet) &&
    a.oxides.length === b.oxides.length &&
    a.oxides.every((line, i) => line.oxide === b.oxides[i].oxide && line.percent === b.oxides[i].percent) &&
    (a.formula ?? []).length === (b.formula ?? []).length &&
    (a.formula ?? []).every((line, i) => line.oxide === b.formula![i].oxide && line.moles === b.formula![i].moles)
  );
}

function sameSheet(a: DataSheet | undefined, b: DataSheet | undefined): boolean {
  return SHEET_FIELDS.every(({ field }) => (a?.[field] ?? '') === (b?.[field] ?? ''));
}

/** The person's own materials, colorants and additives: a list, and an editor for one. */
export function Materials({
  materials,
  deleted,
  recipes,
  editor,
  saving,
  error,
  onOpen,
  onSave,
  onUseRevision,
  onOpenDeleted,
  onDelete,
  onRestore,
  onErase,
  renameInRecipes,
  onRenameInRecipes,
  readOnly = false,
  canCreate = true,
  newIn,
  moveTo
}: {
  materials: MaterialHead[];
  deleted: MaterialHead[];
  recipes: RecipeHead[];
  editor: Editor<MaterialContent>;
  saving: boolean;
  error: string;
  onOpen: (material: MaterialHead | null) => void;
  onSave: () => void;
  onUseRevision: () => void;
  onOpenDeleted: (material: MaterialHead) => void;
  onDelete: () => void;
  onRestore: () => void;
  onErase: () => void;
  /** Whether saving a new name changes it in the recipes that use the old one too. */
  renameInRecipes: boolean;
  onRenameInRecipes: (rename: boolean) => void;
  /** The person may read this material but not change it (a team's vault, ADR 12). */
  readOnly?: boolean;
  canCreate?: boolean;
  /** For a new material in a team's vault, where it will be saved. */
  newIn?: React.ReactNode;
  /** Below a saved material, in a team's vault: moving it to another collection. */
  moveTo?: React.ReactNode;
}) {
  const { current, draft, setDraft, changed, viewing } = editor;
  const shown = viewing?.content ?? draft;
  const check = useMemo(() => checkMaterial(shown), [shown]);
  const [copyFrom, setCopyFrom] = useState('');
  const copied = copyFrom.trim() ? standardAnalysis(copyFrom) : null;

  const usedIn = (name: string) =>
    name.trim()
      ? recipes.filter((r) => r.content.lines.some((line) => sameName(line.material, name)))
      : [];
  const users = usedIn(shown.name);
  const oldUsers =
    current && draft.name.trim() && !sameName(current.content.name, draft.name) ? usedIn(current.content.name) : [];
  const replacesStandard = standardNamed(shown.name);

  const setOxide = (index: number, line: OxideLine) =>
    setDraft({ ...draft, oxides: draft.oxides.map((l, i) => (i === index ? line : l)) });
  const unusedOxide = OXIDES.find((oxide) => !draft.oxides.some((line) => line.oxide === oxide)) ?? 'SiO2';

  return (
    <>
      <nav className="sidebar no-print" aria-label="Your materials">
        {canCreate && (
          <button type="button" className="primary" onClick={() => onOpen(null)}>
            New material
          </button>
        )}
        {materials.length === 0 ? (
          <p className="hint">
            No materials of your own yet. Add one to use your supplier’s analysis, or a colorant or additive the standard
            list does not have.
          </p>
        ) : (
          MATERIAL_CATEGORIES.filter(({ category }) => materials.some((m) => m.content.category === category)).map(
            ({ category, label }) => (
              <section key={category}>
                <h2 className="list-heading">{label}</h2>
                <ul className="list">
                  {materials
                    .filter((m) => m.content.category === category)
                    .sort((a, b) => a.content.name.localeCompare(b.content.name))
                    .map((material) => (
                      <li key={material.recordId}>
                        <button
                          type="button"
                          aria-current={material.recordId === current?.recordId}
                          onClick={() => onOpen(material)}
                        >
                          {material.content.name || 'Untitled'}
                        </button>
                      </li>
                    ))}
                </ul>
              </section>
            )
          )
        )}
        <DeletedList deleted={deleted} nameOf={(c) => c.name} viewing={viewing} onOpen={onOpenDeleted} />
      </nav>

      <main className="editor no-print">
        {viewing?.deleted && (
          <DeletedNotice deleted={viewing} name={viewing.content.name} onRestore={onRestore} onErase={onErase} />
        )}
        {viewing && !viewing.deleted && current && (
          <ViewingNotice
            viewing={viewing}
            newest={current}
            onUse={onUseRevision}
            onBack={() => editor.setViewing(null)}
          />
        )}
        {readOnly && current && !viewing && (
          <p className="hint" role="status">
            You can read this material, but not change it. An admin can change what you may do.
          </p>
        )}
        {!current && !viewing && newIn}
        <fieldset className="plain" disabled={!!viewing || readOnly}>
          <label htmlFor="material-name">Material name</label>
          <input
            id="material-name"
            className="title"
            value={shown.name}
            placeholder="Untitled"
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />

          <label htmlFor="material-category">Kind</label>
          <select
            id="material-category"
            value={shown.category}
            onChange={(e) => setDraft({ ...draft, category: e.target.value as MaterialContent['category'] })}
          >
            {MATERIAL_CATEGORIES.map(({ category, label }) => (
              <option key={category} value={category}>
                {label}
              </option>
            ))}
          </select>

          <label htmlFor="material-class">Class</label>
          <select
            id="material-class"
            value={shown.class ?? ''}
            onChange={(e) => setDraft({ ...draft, class: (e.target.value as MaterialClass) || undefined })}
          >
            <option value="">—</option>
            {MATERIAL_CLASSES.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>

          <label htmlFor="material-basis">Given as</label>
          <select
            id="material-basis"
            value={shown.basis ?? 'analysis'}
            onChange={(e) => setDraft({ ...draft, basis: e.target.value as MaterialContent['basis'] })}
          >
            <option value="analysis">An analysis: weight percent, as on a data sheet</option>
            <option value="formula">A formula: moles of each oxide</option>
          </select>

          {(shown.basis ?? 'analysis') === 'analysis' ? (
            <>
              <table className="lines">
                <caption>Analysis, weight percent of the raw material</caption>
                <thead>
                  <tr>
                    <th scope="col">Oxide</th>
                    <th scope="col" className="num">
                      Percent
                    </th>
                    <th scope="col">
                      <span className="visually-hidden">Remove</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.oxides.map((line, index) => (
                    <tr key={index}>
                      <td>
                        <select
                          aria-label={`Oxide ${index + 1}`}
                          value={line.oxide}
                          onChange={(e) => setOxide(index, { ...line, oxide: e.target.value })}
                        >
                          {OXIDES.map((oxide) => (
                            <option key={oxide} value={oxide}>
                              {oxideLabel(oxide)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="num">
                        <input
                          aria-label={`Percent ${index + 1}`}
                          inputMode="decimal"
                          value={line.percent}
                          onChange={(e) => setOxide(index, { ...line, percent: e.target.value })}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="link"
                          aria-label={`Remove oxide ${index + 1}`}
                          onClick={() => setDraft({ ...draft, oxides: draft.oxides.filter((_, i) => i !== index) })}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">
                      <label htmlFor="material-loi">Loss on ignition</label>
                    </th>
                    <td className="num">
                      <input
                        id="material-loi"
                        inputMode="decimal"
                        value={shown.loi}
                        onChange={(e) => setDraft({ ...draft, loi: e.target.value })}
                      />
                    </td>
                    <td />
                  </tr>
                  <tr>
                    <th scope="row">Total</th>
                    <td className="num" data-testid="material-total">
                      {Number.isFinite(check.total) ? check.total.toFixed(2) : '—'}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
              <button
                type="button"
                onClick={() => setDraft({ ...draft, oxides: [...draft.oxides, { oxide: unusedOxide, percent: '' }] })}
              >
                Add oxide
              </button>
            </>
          ) : (
            <FormulaTable
              formula={shown.formula ?? []}
              check={check}
              onChange={(formula) => setDraft({ ...draft, formula })}
            />
          )}

          <div className="copy-from">
            <label htmlFor="copy-from">Start from a standard material</label>
            <div className="row">
              <input
                id="copy-from"
                list="standard-materials"
                value={copyFrom}
                placeholder="Custer Spar"
                onChange={(e) => setCopyFrom(e.target.value)}
              />
              <button
                type="button"
                disabled={!copied}
                onClick={() => {
                  if (!copied) return;
                  setDraft({ ...draft, ...copied, basis: 'analysis', name: draft.name || copyFrom.trim() });
                  setCopyFrom('');
                }}
              >
                Copy its analysis
              </button>
            </div>
            <datalist id="standard-materials">
              {MATERIAL_NAMES.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>

          <DataSheetFields
            sheet={shown.sheet}
            clay={isClay(shown.class)}
            onChange={(sheet) => setDraft({ ...draft, sheet: tidySheet(sheet) })}
          />

          <label htmlFor="material-notes">Notes</label>
          <textarea
            id="material-notes"
            rows={3}
            value={shown.notes}
            placeholder="Supplier, lot, data sheet date"
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          />
        </fieldset>

        <div className="row">
          {!readOnly && (
            <button type="button" className="primary" disabled={!changed || saving || !!viewing} onClick={onSave}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
          {current && !changed && !viewing && (
            <span className="hint">
              Saved {new Date(current.savedAt).toLocaleString()} · revision {current.number}
            </span>
          )}
          {current && !viewing && !readOnly && (
            <button type="button" className="link danger end" onClick={onDelete}>
              Delete…
            </button>
          )}
        </div>
        {error && <p role="alert" className="error">{error}</p>}
        {moveTo}
        {current && (
          <RevisionHistory kind="material" current={current} viewing={viewing} onView={editor.setViewing} />
        )}
      </main>

      <aside className="analysis no-print" aria-label="Material check">
        {check.noOxides ? (
          <p className="hint">
            With no oxides, this material counts in the batch but is left out of the unity formula, like a gum or a stain
            whose analysis you do not have.
          </p>
        ) : 'unity' in check ? (
          <>
            <h2>Unity formula of the material</h2>
            <table className="umf">
              <tbody>
                {Object.entries(check.unity)
                  .filter(([, moles]) => moles > 0)
                  .sort((a, b) => OXIDES.indexOf(a[0]) - OXIDES.indexOf(b[0]))
                  .map(([oxide, moles]) => (
                    <tr key={oxide}>
                      <th scope="row">{oxideLabel(oxide)}</th>
                      <td className="num">{moles.toFixed(3)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {check.warnings.length > 0 && (
              <ul className="warnings">
                {check.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="error">{check.problem}</p>
        )}
        {replacesStandard && (
          <p className="hint">
            Your recipes use this instead of the standard {replacesStandard}
            {normalize(replacesStandard) === normalize(shown.name)
              ? ', wherever they name it.'
              : `, wherever they call it ${shown.name.trim()}.`}
          </p>
        )}
        {users.length > 0 && (
          <>
            <h2>Used in</h2>
            <ul className="plain-list">
              {users.map((recipe) => (
                <li key={recipe.recordId}>{recipe.content.name || 'Untitled'}</li>
              ))}
            </ul>
          </>
        )}
        {oldUsers.length > 0 && (
          <>
            <p className="warn">
              {oldUsers.length === 1 ? '1 recipe uses' : `${oldUsers.length} recipes use`} the old name,{' '}
              {current!.content.name}:
            </p>
            <ul className="plain-list">
              {oldUsers.map((recipe) => (
                <li key={recipe.recordId}>{recipe.content.name || 'Untitled'}</li>
              ))}
            </ul>
            <label className="check">
              <input type="checkbox" checked={renameInRecipes} onChange={(e) => onRenameInRecipes(e.target.checked)} />
              Also rename it in {oldUsers.length === 1 ? 'this recipe' : 'these recipes'} when saving
            </label>
          </>
        )}
      </aside>
    </>
  );
}

/** A data sheet's physical values, folded away until a clay's or once any is filled in. */
function DataSheetFields({
  sheet,
  clay,
  onChange
}: {
  sheet: DataSheet | undefined;
  clay: boolean;
  onChange: (sheet: DataSheet) => void;
}) {
  return (
    <details className="data-sheet" open={clay || hasSheet(sheet)}>
      <summary>Data sheet</summary>
      <p className="hint">All optional: what the supplier’s sheet gives, for clays most of all.</p>
      <div className="details">
        {SHEET_FIELDS.map(({ field, label, unit, placeholder }) => (
          <div key={field} className="detail">
            <label htmlFor={`sheet-${field}`}>
              {label}
              {unit && <span className="hint"> ({unit})</span>}
            </label>
            <input
              id={`sheet-${field}`}
              inputMode={field === 'mesh' || field === 'dryStrength' ? undefined : 'decimal'}
              value={sheet?.[field] ?? ''}
              placeholder={placeholder}
              onChange={(e) => onChange({ ...sheet, [field]: e.target.value })}
            />
          </div>
        ))}
      </div>
    </details>
  );
}

/** A material given as a molar formula: moles of each oxide, and of what burns off. */
function FormulaTable({
  formula,
  check,
  onChange
}: {
  formula: FormulaLine[];
  check: MaterialCheck;
  onChange: (formula: FormulaLine[]) => void;
}) {
  const setLine = (index: number, line: FormulaLine) => onChange(formula.map((l, i) => (i === index ? line : l)));
  const unused = FORMULA_PARTS.find((part) => !formula.some((line) => line.oxide === part)) ?? 'SiO2';
  return (
    <>
      <table className="lines">
        <caption>Formula, moles of each oxide, with water, carbon dioxide or sulfur that burn off</caption>
        <thead>
          <tr>
            <th scope="col">Oxide</th>
            <th scope="col" className="num">
              Moles
            </th>
            <th scope="col">
              <span className="visually-hidden">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {formula.map((line, index) => (
            <tr key={index}>
              <td>
                <select
                  aria-label={`Formula oxide ${index + 1}`}
                  value={line.oxide}
                  onChange={(e) => setLine(index, { ...line, oxide: e.target.value })}
                >
                  {FORMULA_PARTS.map((part) => (
                    <option key={part} value={part}>
                      {oxideLabel(part)}
                    </option>
                  ))}
                </select>
              </td>
              <td className="num">
                <input
                  aria-label={`Moles ${index + 1}`}
                  inputMode="decimal"
                  value={line.moles}
                  onChange={(e) => setLine(index, { ...line, moles: e.target.value })}
                />
              </td>
              <td>
                <button
                  type="button"
                  className="link"
                  aria-label={`Remove formula oxide ${index + 1}`}
                  onClick={() => onChange(formula.filter((_, i) => i !== index))}
                >
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Formula weight</th>
            <td className="num" data-testid="material-total">
              {Number.isFinite(check.total) && check.total > 0 ? check.total.toFixed(2) : '—'}
            </td>
            <td />
          </tr>
          <tr>
            <th scope="row">Loss on ignition</th>
            <td className="num">{'loi' in check ? `${check.loi.toFixed(2)}%` : '—'}</td>
            <td />
          </tr>
        </tfoot>
      </table>
      <button type="button" onClick={() => onChange([...formula, { oxide: unused, moles: '' }])}>
        Add oxide
      </button>
    </>
  );
}
