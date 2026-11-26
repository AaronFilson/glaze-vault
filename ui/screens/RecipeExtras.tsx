import { api, type Access, type Kind, type MaterialHead, type RecipeHead } from '../api';
import type { BatchSheet } from '../batch';
import { sameName, type MaterialContent, type RecipeContent } from '../chemistry';
import { firingOf, newFiring, type Firing } from '../firing';
import { mixOf, newMix, type Mix } from '../mix';
import { canEdit, may } from '../team';
import type { Editor } from '../useEditor';
import { BatchSheetForm } from './BatchSheets';
import type { FiringEditing } from './FiringLog';
import type { MixEditing } from './MixLog';
import { MoveTo } from './Team';

/** Below a saved recipe someone may change, in a team's vault: its batch sheet. */
export function RecipeBatchSheetSection({
  team,
  access,
  recipe,
  recipes,
  sheets,
  making,
  onMaking,
  onSaved
}: {
  team: boolean;
  access: Access | null;
  recipe: Editor<RecipeContent>;
  recipes: RecipeHead[];
  sheets: BatchSheet[];
  making: boolean;
  onMaking: (making: boolean) => void;
  onSaved: (saved: BatchSheet) => void;
}) {
  const current = recipe.current;
  if (!team || !current || recipe.viewing || !canEdit(access, current.collectionId, 'batch')) return null;
  const made = sheets.find((s) => s.content.recipe === current.recordId) ?? null;
  if (making) {
    return (
      <BatchSheetForm
        key={current.revisionId}
        recipe={current}
        sheet={made}
        sheets={sheets}
        recipes={recipes}
        onSaved={onSaved}
        onCancel={() => onMaking(false)}
      />
    );
  }
  const status = !made
    ? ''
    : made.content.recipeNumber === current.number
      ? 'Its batch sheet is up to date.'
      : `Its batch sheet was made from revision ${made.content.recipeNumber}. Update it to weigh this one.`;
  return (
    <div className="row">
      <button type="button" disabled={recipe.changed} onClick={() => onMaking(true)}>
        Batch sheet…
      </button>
      {status && <span className="hint">{status}</span>}
    </div>
  );
}

/** Below a saved recipe someone may change, in a team's vault: moving it to another collection,
 * with its firings, mixes and batch sheets. */
export function RecipeMoveSection({
  team,
  access,
  names,
  recipe,
  firings,
  sheets,
  mixes,
  onMoved
}: {
  team: boolean;
  access: Access | null;
  names: Record<string, string>;
  recipe: Editor<RecipeContent>;
  firings: Firing[];
  sheets: BatchSheet[];
  mixes: Mix[];
  onMoved: (to: string, ids: { firings: string[]; sheets: string[]; mixes: string[] }) => void;
}) {
  const current = recipe.current;
  if (!team || !access || !current || recipe.viewing) return null;
  const ownFirings = firings.filter((f) => f.content.recipe === current.recordId);
  const ownSheets = sheets.filter((s) => s.content.recipe === current.recordId);
  const ownMixes = mixes.filter((m) => mixOf(m.content, current.recordId));
  const kinds: Kind[] = [
    'recipe',
    ...(ownFirings.length ? (['firing'] as const) : []),
    ...(ownSheets.length ? (['batch'] as const) : []),
    ...(ownMixes.length ? (['mix'] as const) : [])
  ];
  if (!kinds.every((kind) => canEdit(access, current.collectionId, kind))) return null;
  const along = [
    ownFirings.length ? (ownFirings.length === 1 ? 'its firing' : `its ${ownFirings.length} firings`) : '',
    ownSheets.length ? 'its batch sheet' : '',
    ownMixes.length ? (ownMixes.length === 1 ? 'its mix' : `its ${ownMixes.length} mixes`) : ''
  ].filter(Boolean);
  return (
    <MoveTo
      key={`${current.recordId} ${current.collectionId}`}
      access={access}
      names={names}
      from={current.collectionId!}
      kinds={kinds}
      name={current.content.name}
      along={along}
      onMove={async (to) => {
        await api.moveRecords(
          [
            ['recipe', current.recordId],
            ...ownFirings.map((f): [Kind, string] => ['firing', f.recordId]),
            ...ownSheets.map((s): [Kind, string] => ['batch', s.recordId]),
            ...ownMixes.map((m): [Kind, string] => ['mix', m.recordId])
          ],
          to
        );
        onMoved(to, {
          firings: ownFirings.map((f) => f.recordId),
          sheets: ownSheets.map((s) => s.recordId),
          mixes: ownMixes.map((m) => m.recordId)
        });
      }}
    />
  );
}

/** Below a saved material someone may change, in a team's vault: moving it to another collection. */
export function MaterialMoveSection({
  team,
  access,
  names,
  material,
  recipes,
  onMoved
}: {
  team: boolean;
  access: Access | null;
  names: Record<string, string>;
  material: Editor<MaterialContent>;
  recipes: RecipeHead[];
  onMoved: (current: MaterialHead, to: string) => void;
}) {
  const current = material.current;
  if (!team || !access || !current || material.viewing) return null;
  if (!canEdit(access, current.collectionId, 'material')) return null;
  const users = recipes.filter((r) => r.content.lines.some((line) => sameName(line.material, current.content.name)));
  return (
    <MoveTo
      key={`${current.recordId} ${current.collectionId}`}
      access={access}
      names={names}
      from={current.collectionId!}
      kinds={['material']}
      name={current.content.name}
      along={[]}
      note={(to, there) => {
        const elsewhere = users.filter((r) => r.collectionId !== to).length;
        if (!elsewhere) return '';
        const one = elsewhere === 1;
        return `${one ? '1 recipe' : `${elsewhere} recipes`} outside ${there} ${one ? 'uses' : 'use'} it. People who cannot open ${there} will see ${one ? 'it' : 'them'} worked out without it, or with the standard material of that name.`;
      }}
      onMove={async (to) => {
        await api.moveRecords([['material', current.recordId]], to);
        onMoved(current, to);
      }}
    />
  );
}

/** Below a saved recipe: its mixes, firings, blends, and logging a new firing or mix. */
export function RecipeLogsAndToolsRow({
  recipe,
  recipesCount,
  access,
  firings,
  mixes,
  onShowFirings,
  onShowMixes,
  onBlend
}: {
  recipe: Editor<RecipeContent>;
  recipesCount: number;
  access: Access | null;
  firings: Firing[];
  mixes: Mix[];
  onShowFirings: (recordId: string, editing: FiringEditing | null) => void;
  onShowMixes: (recordId: string, editing: MixEditing | null) => void;
  onBlend: (recordId: string) => void;
}) {
  const current = recipe.current;
  if (!current || recipe.viewing) return null;
  // A body's firings include the glazes fired on it, as the log lists them.
  const count = firings.filter((f) => firingOf(f.content, current.recordId)).length;
  const mixCount = mixes.filter((m) => mixOf(m.content, current.recordId)).length;
  return (
    <div className="row">
      {mixCount > 0 && (
        <button type="button" onClick={() => onShowMixes(current.recordId, null)}>
          Mixes ({mixCount})
        </button>
      )}
      {count > 0 && (
        <button type="button" onClick={() => onShowFirings(current.recordId, null)}>
          Firings ({count})
        </button>
      )}
      {recipesCount > 1 && may(access, current.collectionId, 'chemistry') && (
        <button type="button" onClick={() => onBlend(current.recordId)}>
          Blend…
        </button>
      )}
      {canEdit(access, current.collectionId, 'firing') && (
        <button
          type="button"
          onClick={() =>
            onShowFirings(current.recordId, {
              current: null,
              draft: newFiring(
                { recordId: current.recordId, number: current.number, name: current.content.name },
                new Date()
              )
            })
          }
        >
          Log a firing…
        </button>
      )}
      {canEdit(access, current.collectionId, 'mix') && (
        <button
          type="button"
          onClick={() => onShowMixes(current.recordId, { current: null, draft: newMix({ recipe: current }, new Date()) })}
        >
          Log a mix…
        </button>
      )}
    </div>
  );
}
