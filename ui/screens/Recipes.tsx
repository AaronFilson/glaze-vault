import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  type DraftPart,
  api,
  errorText,
  type Access,
  type Draft,
  type Kind,
  type LastBackup,
  type MaterialHead,
  type RecipeHead,
  type Revision,
  type Settings as VaultSettings,
  type UpdateInfo,
  type VaultChanged,
  type VaultStatus,
  onEvent
} from '../api';
import { BATCH_UNITS, type BatchSheet, type BatchUnit } from '../batch';
import {
  amountOf,
  analyse,
  materialLibrary,
  sameName,
  standardNamed,
  type MaterialContent,
  type RecipeContent
} from '../chemistry';
import { localDate } from '../export';
import { restorePart, useEditor, type Editor } from '../useEditor';
import { useIdleLock } from '../useIdleLock';
import { BatchSheetForm, BatchSheets } from './BatchSheets';
import { Blend } from './Blend';
import { Fit } from './Fit';
import { LimitSets, LimitsPanel, limitSets, savedLimitChoice } from './Limits';
import type { LimitsContent } from '../limits';
import type { PricesContent } from '../prices';
import { CostLine, PriceLists } from './Prices';
import { priceListFor } from '../prices';
import { Compare, type Side } from './Compare';
import { FiringLog, type FiringEditing } from './FiringLog';
import { firingOf, newFiring, sameFiring, type Firing, type FiringContent } from '../firing';
import { MixLog, type MixEditing } from './MixLog';
import { mixOf, newMix, sameMix, type Mix, type MixContent } from '../mix';
import { ConfirmNotice } from './Deleted';
import { Import } from './Import';
import type { ImportPlan } from '../importFormats';
import { EMPTY_MATERIAL, Materials, sameMaterial } from './Materials';
import { PrintView, type PrintJob } from './PrintView';
import { EMPTY_RECIPE, RecipeEditor, sameRecipe } from './RecipeEditor';
import { RecoverySheet } from './RecoverySheet';
import { Settings } from './Settings';
import { SyncIndicator } from './SyncIndicator';
import { OfflineNotice } from './OfflineNotice';
import { CollectionPicker, MoveTo } from './Team';
import { byCollection, canEdit, defaultCollection, editableCollections, may, onlyWeighs } from '../team';

const DAY = 24 * 60 * 60 * 1000;
/** How long after the last keystroke unsaved edits are kept as a draft. */
export const DRAFT_DELAY_MS = 1000;

type Scope = 'recipe' | 'material' | 'all';

/** One kind's lists and editor, for what deleting, restoring and erasing do the same for both. */
interface Records<Content> {
  kind: 'recipe' | 'material';
  editor: Editor<Content>;
  setHeads: Dispatch<SetStateAction<Revision<Content>[]>>;
  setDeleted: Dispatch<SetStateAction<Revision<Content>[]>>;
  setError: (error: string) => void;
}

export type LockReason = 'manual' | 'idle' | 'idle-with-draft' | 'switched' | 'left';

/** The open vault: the recipe list and editor, materials, settings, printing, and the notices
 * above them. */
export function Recipes({
  status,
  update,
  onUpdate,
  onLocked
}: {
  status: VaultStatus;
  update: UpdateInfo | null;
  onUpdate: (update: UpdateInfo | null) => void;
  onLocked: (reason: LockReason) => void;
}) {
  const [recipes, setRecipes] = useState<RecipeHead[]>([]);
  const [materials, setMaterials] = useState<MaterialHead[]>([]);
  const [deletedRecipes, setDeletedRecipes] = useState<RecipeHead[]>([]);
  const [deletedMaterials, setDeletedMaterials] = useState<MaterialHead[]>([]);
  const recipe = useEditor<RecipeContent>(EMPTY_RECIPE, sameRecipe);
  const material = useEditor<MaterialContent>(EMPTY_MATERIAL, sameMaterial);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [materialError, setMaterialError] = useState('');
  const [backupError, setBackupError] = useState('');
  const [renameInRecipes, setRenameInRecipes] = useState(true);
  const [switchError, setSwitchError] = useState('');
  const [saving, setSaving] = useState(false);
  // What to do once unsaved changes are saved or discarded. The system webview on macOS has no
  // window.confirm(), so the question is asked in the page.
  const [pending, setPending] = useState<{ scope: Scope; action: () => void } | null>(null);
  const [confirming, setConfirming] = useState<{ action: 'delete' | 'erase'; kind: Kind } | null>(null);
  const [view, setView] = useState<
    'recipes' | 'materials' | 'settings' | 'compare' | 'import' | 'batches' | 'firings' | 'mixes' | 'blend' | 'fit'
  >('recipes');
  // The firing log (ADR 14): every firing, the one being edited, and the recipe it is showing.
  const [firings, setFirings] = useState<Firing[]>([]);
  const [firing, setFiring] = useState<FiringEditing | null>(null);
  const [firingsOf, setFiringsOf] = useState<string | null>(null);
  const [mixes, setMixes] = useState<Mix[]>([]);
  const [mix, setMix] = useState<MixEditing | null>(null);
  const [mixesOf, setMixesOf] = useState<string | null>(null);
  // The recipe a line blend starts from.
  const [blendFrom, setBlendFrom] = useState<string | null>(null);
  // People's own limit formulas, and the set the unity formula is compared with (ADR 15).
  const [ownLimits, setOwnLimits] = useState<Revision<LimitsContent>[]>([]);
  const [limitChoice, setLimitChoice] = useState(savedLimitChoice);
  // The price lists the person can open, newest first: a recipe is costed by its collection's.
  const [priceLists, setPriceLists] = useState<Revision<PricesContent>[]>([]);
  // Batch sheets (ADR 12): the one open, and whether the open recipe's is being made.
  const [sheets, setSheets] = useState<BatchSheet[]>([]);
  const [sheet, setSheet] = useState<BatchSheet | null>(null);
  const [makingSheet, setMakingSheet] = useState(false);
  const [importing, setImporting] = useState<{ fileName: string; plan: ImportPlan } | null>(null);
  const [comparing, setComparing] = useState<[Side, Side] | null>(null);
  const [settings, setSettings] = useState<VaultSettings | null>(null);
  const [lastBackup, setLastBackup] = useState<LastBackup | null>(null);
  const [kept, setKept] = useState({ recipe: false, material: false, firing: false, mix: false });
  const [newWords, setNewWords] = useState<string[] | null>(null);
  const [organizationWords, setOrganizationWords] = useState<string[] | null>(null);
  // Who is signed in and what they can open; in a team's vault, names for other people's
  // private collections (admins only), and where new records go (ADR 12).
  const [access, setAccess] = useState<Access | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [newCollection, setNewCollection] = useState<string | null>(null);
  const [reminderHidden, setReminderHidden] = useState(false);
  const [updateHidden, setUpdateHidden] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [printJob, setPrintJob] = useState<PrintJob>({ kind: 'recipe' });
  const [printRequest, setPrintRequest] = useState(0);
  // Whether the vault holds a draft, so one is only cleared when there is one.
  const draftKept = useRef(false);
  // Draft writes, one after another: the core runs commands side by side, and a draft kept after
  // it was cleared would come back.
  const draftWrites = useRef<Promise<unknown>>(Promise.resolve());
  const writeDraft = <T,>(write: () => Promise<T>): Promise<T> => {
    const done = draftWrites.current.then(write);
    draftWrites.current = done.catch(() => {});
    return done;
  };

  const loadAccess = async () => {
    const now = await api.access();
    setAccess(now);
    setNewCollection((chosen) =>
      chosen && editableCollections(now).some((c) => c.id === chosen) ? chosen : defaultCollection(now)
    );
    if (now.team && now.me.admin) {
      const team = await api.team();
      setNames(Object.fromEntries(team.people.map((p) => [p.id, p.name])));
    }
    return now;
  };

  /** After growing or changing the team: access, and the lists, which now show collections. */
  const reloadAccess = () => {
    Promise.all([
      loadAccess(),
      api.recipes(),
      api.materials(),
      api.batchSheets(),
      api.firings(),
      api.limitSets(),
      api.priceLists(),
      api.mixes()
    ])
      .then(([, heads, ownMaterials, batchSheets, allFirings, limits, priceLists, allMixes]) => {
        setPriceLists(priceLists);
        setRecipes(heads);
        setMaterials(ownMaterials);
        recipe.follow(heads);
        material.follow(ownMaterials);
        setSheets(batchSheets);
        setFirings(allFirings);
        setMixes(allMixes);
        setOwnLimits(limits);
      })
      .catch((e) => setError(errorText(e)));
  };

  // A vault that syncs with a host syncs by itself while open (docs/adr/0023-client-mode.md); the
  // lists are read again when a sync brings something.
  useEffect(() => onEvent<VaultChanged>('vault-changed', (changed) => changed.pulled && reloadAccess()), []);

  useEffect(() => {
    (async () => {
      const [now, heads, ownMaterials, gone, goneMaterials, settings, last, draft, batchSheets, allFirings, limits, priceLists, allMixes] =
        await Promise.all([
        loadAccess(),
        api.recipes(),
        api.materials(),
        api.deletedRecords<RecipeContent>('recipe'),
        api.deletedRecords<MaterialContent>('material'),
        api.settings(),
        api.lastBackup(),
        api.draft(),
        api.batchSheets(),
        api.firings(),
        api.limitSets(),
        api.priceLists(),
        api.mixes()
      ]);
      setOwnLimits(limits);
      setMixes(allMixes);
      setPriceLists(priceLists);
      setRecipes(heads);
      setSheets(batchSheets);
      setFirings(allFirings);
      // Someone who only weighs batches starts on the batch sheets.
      if (onlyWeighs(now)) setView('batches');
      setMaterials(ownMaterials);
      setDeletedRecipes(gone);
      setDeletedMaterials(goneMaterials);
      setSettings(settings);
      setLastBackup(last);
      draftKept.current = !!draft;
      const keptRecipe = draft?.recipe && restorePart(draft.recipe, heads, sameRecipe);
      const keptMaterial = draft?.material && restorePart(draft.material, ownMaterials, sameMaterial);
      const keptFiring = draft?.firing && restorePart(draft.firing, allFirings, sameFiring);
      const keptMix = draft?.mix && restorePart(draft.mix, allMixes, sameMix);
      if (keptRecipe) recipe.show(keptRecipe.current, keptRecipe.content);
      if (keptMaterial) material.show(keptMaterial.current, keptMaterial.content);
      if (keptFiring) setFiring({ current: keptFiring.current, draft: keptFiring.content });
      if (keptMix) setMix({ current: keptMix.current, draft: keptMix.content });
      if (keptMaterial && !keptRecipe) setView('materials');
      else if (keptFiring && !keptRecipe) setView('firings');
      else if (keptMix && !keptRecipe) setView('mixes');
      setKept({ recipe: !!keptRecipe, material: !!keptMaterial, firing: !!keptFiring, mix: !!keptMix });
      setLoaded(true);
    })().catch((e) => setError(errorText(e)));
    // Once, on opening.
  }, []);

  // A firing being logged or changed, as a draft. A new one counts from when it is opened.
  const firingChanged = !!firing && (!firing.current || !sameFiring(firing.current.content, firing.draft));
  const firingPart: DraftPart<FiringContent> | undefined =
    firing && firingChanged
      ? { recordId: firing.current?.recordId ?? null, revisionId: firing.current?.revisionId ?? null, content: firing.draft }
      : undefined;
  // Opening another firing, or saving this one, ends what was kept from last time.
  const editFiring = (next: FiringEditing | null) => {
    if (!next || next.current !== firing?.current) setKept((k) => ({ ...k, firing: false }));
    setFiring(next);
  };
  // For locking, which may run after the recipe's and material's changes are saved or discarded.
  const firingPartRef = useRef(firingPart);
  firingPartRef.current = firingPart;

  // A mix being logged or changed, kept the same way.
  const mixChanged = !!mix && (!mix.current || !sameMix(mix.current.content, mix.draft));
  const mixPart: DraftPart<MixContent> | undefined =
    mix && mixChanged
      ? { recordId: mix.current?.recordId ?? null, revisionId: mix.current?.revisionId ?? null, content: mix.draft }
      : undefined;
  const editMix = (next: MixEditing | null) => {
    if (!next || next.current !== mix?.current) setKept((k) => ({ ...k, mix: false }));
    setMix(next);
  };
  const mixPartRef = useRef(mixPart);
  mixPartRef.current = mixPart;

  // Keeps unsaved edits as an encrypted draft a moment after the last change, and forgets the
  // draft as soon as nothing is unsaved.
  const unsaved: Draft | null =
    recipe.part || material.part || firingPart || mixPart
      ? { recipe: recipe.part, material: material.part, firing: firingPart, mix: mixPart }
      : null;
  const unsavedJson = JSON.stringify(unsaved);
  useEffect(() => {
    if (!loaded) return;
    if (!unsaved) {
      if (draftKept.current) {
        draftKept.current = false;
        writeDraft(api.clearDraft).catch(() => {});
      }
      return;
    }
    const timer = setTimeout(() => {
      draftKept.current = true;
      writeDraft(() => api.saveDraft(unsaved)).catch(() => {});
    }, DRAFT_DELAY_MS);
    return () => clearTimeout(timer);
    // unsavedJson stands for unsaved, which is a new object every render.
  }, [loaded, unsavedJson]);

  // Print once the page shows the chosen layout.
  useEffect(() => {
    if (printRequest) window.print();
  }, [printRequest]);

  // The audit log notes each record opened (ADR 19); the core notes each once a sign-in.
  useOpened('recipe', recipe.current?.recordId);
  useOpened('material', material.current?.recordId);
  useOpened('batch', sheet?.recordId);
  useOpened('firing', firing?.current?.recordId);

  const library = useMemo(() => materialLibrary(materials.map((m) => m.content)), [materials]);
  const shownRecipe = recipe.viewing?.content ?? recipe.draft;
  const prices =
    priceListFor(priceLists, (recipe.viewing ?? recipe.current)?.collectionId ?? newCollection)?.content ?? null;
  const analysis = useMemo(() => analyse(shownRecipe.lines, library), [shownRecipe.lines, library]);

  useIdleLock(settings?.autoLock && !newWords ? settings.autoLockMinutes : null, async () => {
    try {
      if (unsaved) {
        await writeDraft(() => api.lockWithDraft(unsaved));
        onLocked('idle-with-draft');
      } else {
        await api.lock();
        onLocked('idle');
      }
    } catch {
      await api.lock().catch(() => {});
      onLocked('idle');
    }
  });

  const unsavedIn = (scope: Scope) =>
    (scope !== 'material' && recipe.changed) || (scope !== 'recipe' && material.changed);

  /** Runs `action` now, or once the person has saved or discarded the changes it would lose. */
  const leave = (scope: Scope, action: () => void) =>
    unsavedIn(scope) ? setPending({ scope, action }) : action();

  const openRecipe = (head: RecipeHead | null) =>
    leave('recipe', () => {
      recipe.open(head);
      setMakingSheet(false);
      setError('');
      setKept((k) => ({ ...k, recipe: false }));
      setView('recipes');
    });

  const openMaterial = (head: MaterialHead | null) =>
    leave('material', () => {
      material.open(head);
      setMaterialError('');
      setKept((k) => ({ ...k, material: false }));
    });

  const saveRecipe = async (): Promise<boolean> => {
    setSaving(true);
    setError('');
    try {
      const saved = await api.saveRecipe(
        recipe.current?.revisionId ?? null,
        recipe.draft,
        recipe.current ? null : newCollection
      );
      recipe.show(saved);
      setRecipes((list) => [saved, ...list.filter((r) => r.recordId !== saved.recordId)]);
      setKept((k) => ({ ...k, recipe: false }));
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveMaterial = async (): Promise<boolean> => {
    const name = material.draft.name.trim();
    const clash = materials.find(
      (m) => m.recordId !== material.current?.recordId && sameName(m.content.name, name)
    );
    if (!name || clash) {
      setMaterialError(
        name ? `You already have a material called ${clash!.content.name}.` : 'Give the material a name.'
      );
      return false;
    }
    setSaving(true);
    setMaterialError('');
    try {
      const oldName = material.current?.content.name;
      const saved = await api.saveMaterial(
        material.current?.revisionId ?? null,
        { ...material.draft, name },
        material.current ? null : newIn('material')
      );
      material.show(saved);
      setMaterials((list) => [saved, ...list.filter((m) => m.recordId !== saved.recordId)]);
      setKept((k) => ({ ...k, material: false }));
      if (renameInRecipes && oldName && !sameName(oldName, name)) await renameMaterial(oldName, name);
      return true;
    } catch (e) {
      setMaterialError(errorText(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  /** Puts a material's new name in every recipe that uses its old one, each as a new revision. */
  const renameMaterial = async (oldName: string, name: string) => {
    const rename = (content: RecipeContent): RecipeContent => ({
      ...content,
      lines: content.lines.map((line) => (sameName(line.material, oldName) ? { ...line, material: name } : line))
    });
    const all = recipes.filter((r) => r.content.lines.some((line) => sameName(line.material, oldName)));
    // In a team's vault, recipes this person may only read keep the old name.
    const users = all.filter((r) => canEdit(access, r.collectionId));
    const readOnly = all.filter((r) => !users.includes(r)).map((r) => r.content.name || 'Untitled');
    const failed: string[] = [];
    for (const head of users) {
      try {
        const saved = await api.saveRecipe(head.revisionId, rename(head.content));
        setRecipes((list) => [saved, ...list.filter((r) => r.recordId !== saved.recordId)]);
        recipe.rebase(saved, rename);
      } catch {
        failed.push(head.content.name || 'Untitled');
      }
    }
    const problems = [
      failed.length && `The new name could not be put in ${failed.join(', ')}. Change it there by hand.`,
      readOnly.length && `You may not change ${readOnly.join(', ')}, so they still use ${oldName}.`
    ].filter(Boolean);
    if (problems.length) setMaterialError(problems.join(' '));
  };

  // A firing or mix being edited is kept for next time rather than asked about: its editor may
  // not be on the screen to save it from.
  const lock = () =>
    leave('all', async () => {
      const [firing, mix] = [firingPartRef.current, mixPartRef.current];
      if (firing || mix) await writeDraft(() => api.lockWithDraft({ firing, mix }));
      else await api.lock();
      onLocked('manual');
    });

  const resolvePending = async (choice: 'save' | 'discard' | 'stay') => {
    if (!pending) return;
    const { scope, action } = pending;
    setPending(null);
    if (choice === 'stay') return;
    const doRecipe = scope !== 'material' && recipe.changed;
    const doMaterial = scope !== 'recipe' && material.changed;
    if (choice === 'save') {
      if (doRecipe && !(await saveRecipe())) return;
      if (doMaterial && !(await saveMaterial())) return;
    } else {
      if (doRecipe) recipe.discard();
      if (doMaterial) material.discard();
    }
    action();
  };

  const records = {
    recipe: { kind: 'recipe', editor: recipe, setHeads: setRecipes, setDeleted: setDeletedRecipes, setError },
    material: {
      kind: 'material',
      editor: material,
      setHeads: setMaterials,
      setDeleted: setDeletedMaterials,
      setError: setMaterialError
    }
  } satisfies { recipe: Records<RecipeContent>; material: Records<MaterialContent> };

  /** Shows a deleted record, to restore or erase. */
  const openDeleted = <Content,>(r: Records<Content>, gone: Revision<Content>) =>
    leave(r.kind, () => {
      r.editor.look(gone);
      r.setError('');
      setKept((k) => ({ ...k, [r.kind]: false }));
    });

  /** Deletes the open record, unsaved edits and all. */
  const deleteRecord = async <Content,>(r: Records<Content>) => {
    const newest = r.editor.current!;
    try {
      const gone = await api.deleteRecord<Content>(r.kind, newest.revisionId);
      r.setHeads((list) => list.filter((head) => head.recordId !== gone.recordId));
      r.setDeleted((list) => [gone, ...list]);
      r.editor.show(null);
      setKept((k) => ({ ...k, [r.kind]: false }));
    } catch (e) {
      r.setError(errorText(e));
    }
  };

  const restoreRecord = async <Content,>(r: Records<Content>, clash?: string) => {
    const gone = r.editor.viewing!;
    if (clash) {
      r.setError(`You have another material called ${clash}. Rename one of them, then restore this one.`);
      return;
    }
    try {
      const saved = await api.saveRecord<Content>(r.kind, gone.revisionId, gone.content);
      r.setDeleted((list) => list.filter((d) => d.recordId !== saved.recordId));
      r.setHeads((list) => [saved, ...list]);
      r.editor.show(saved);
      r.setError('');
    } catch (e) {
      r.setError(errorText(e));
    }
  };

  /** Ends a fork of the open record by keeping one of its newest revisions (ADR 17). */
  const keepVersion = <Content,>(r: Records<Content>, keep: string) =>
    leave(r.kind, async () => {
      const head = r.editor.current;
      if (!head) return;
      const others = [head.revisionId, ...(head.forks ?? []).map((fork) => fork.revisionId)].filter(
        (id) => id !== keep
      );
      try {
        const saved = await api.resolveFork<Content>(r.kind, keep, others);
        r.setHeads((list) => [
          ...(saved.deleted ? [] : [saved]),
          ...list.filter((other) => other.recordId !== saved.recordId)
        ]);
        if (saved.deleted) {
          r.setDeleted((list) => [saved, ...list]);
          r.editor.show(null);
        } else {
          r.editor.show(saved);
        }
        r.setError('');
      } catch (e) {
        r.setError(errorText(e));
      }
    });

  const eraseRecord = async <Content,>(r: Records<Content>) => {
    const gone = r.editor.viewing!;
    try {
      await api.eraseRecord(r.kind, gone.recordId);
      r.setDeleted((list) => list.filter((d) => d.recordId !== gone.recordId));
      r.editor.show(null);
    } catch (e) {
      r.setError(errorText(e));
    }
  };

  const confirm = () => {
    if (!confirming) return;
    const { action, kind } = confirming;
    setConfirming(null);
    const act = action === 'delete' ? deleteRecord : eraseRecord;
    void (kind === 'recipe' ? act(records.recipe) : act(records.material));
  };

  /** Puts an earlier revision in the editor, once the edits it would replace are saved or discarded. */
  const takeRevision = <Content,>(scope: 'recipe' | 'material', editor: Editor<Content>) => {
    const content = editor.viewing!.content;
    leave(scope, () => editor.edit(content));
  };

  const backUp = async () => {
    const saved = await api.backUp(`Glaze Vault backup ${localDate(new Date())}.gvbackup`);
    if (saved) setLastBackup(saved);
  };

  const saveSettings = async (next: VaultSettings) => {
    await api.setSettings(next);
    setSettings(next);
  };

  const install = () =>
    leave('all', async () => {
      setInstalling(true);
      try {
        await api.installUpdate();
      } catch (e) {
        setInstalling(false);
        // The vault is locked just before installing, so a failed install can leave it locked.
        const now = await api.status().catch(() => null);
        if (now && !now.unlocked) onLocked('manual');
        else setError(errorText(e));
      }
    });

  const print = (job: PrintJob) => {
    setPrintJob(job);
    setPrinting(false);
    setPrintRequest((n) => n + 1);
    const printed = job.kind === 'batch' ? sheet : (recipe.viewing ?? recipe.current);
    if (printed) {
      const detail = job.kind === 'batch' ? `${job.size} ${job.unit}` : `revision ${printed.number}`;
      api.note({ action: 'printed', kind: job.kind, record: printed.recordId, detail }).catch(() => {});
    }
  };

  if (newWords) {
    return <RecoverySheet words={newWords} doneLabel="Done" onDone={() => setNewWords(null)} />;
  }
  if (organizationWords) {
    return (
      <RecoverySheet
        words={organizationWords}
        organization
        doneLabel="Done"
        onDone={() => {
          setOrganizationWords(null);
          reloadAccess();
        }}
      />
    );
  }

  const team = !!access?.team;
  const mayCreate = !team || editableCollections(access).length > 0;
  const picker = team && access && (
    <CollectionPicker access={access} names={names} value={newCollection} onChange={setNewCollection} />
  );
  /** Where a new record of a kind goes: the collection chosen, if this person may make that kind
   * there, else the first where they may. */
  const newIn = (kind: Kind) =>
    !team || canEdit(access, newCollection, kind) ? newCollection : defaultCollection(access, kind);
  const reminderDays = settings?.backupReminderDays ?? 0;
  const backupDue =
    // In a team's vault only admins back up.
    (!team || !!access?.me.admin) &&
    !reminderHidden &&
    reminderDays > 0 &&
    recipes.length > 0 &&
    (!lastBackup || Date.now() - lastBackup.at > reminderDays * DAY);
  const pendingNames = pending
    ? [
        pending.scope !== 'material' && recipe.changed && (recipe.draft.name || 'This recipe'),
        pending.scope !== 'recipe' && material.changed && (material.draft.name || 'This material')
      ].filter((name): name is string => !!name)
    : [];
  // What Compare starts with: the unsaved changes and what they started from, an earlier revision
  // and the newest, or this recipe and another.
  const compareFrom = (number?: number): [Side, Side] | null => {
    const current = recipe.current;
    const other = recipes.find((r) => r.recordId !== current?.recordId);
    if (current && number) return [{ recordId: current.recordId, number }, { recordId: current.recordId, number: null }];
    if (recipe.changed) {
      const base = current ?? other;
      return base ? [{ recordId: base.recordId, number: null }, { draft: true }] : null;
    }
    if (current && current.number > 1) {
      return [{ recordId: current.recordId, number: current.number - 1 }, { recordId: current.recordId, number: null }];
    }
    if (current && other) return [{ recordId: current.recordId, number: null }, { recordId: other.recordId, number: null }];
    return null;
  };
  // What this person may do with the recipe shown, in its collection (ADR 4).
  const shownIn = recipe.current ? recipe.current.collectionId : newCollection;
  const chemistry = may(access, shownIn, 'chemistry');
  const canCompare = chemistry && !!compareFrom();

  const confirmText = () => {
    if (!confirming) return null;
    const editor = confirming.kind === 'recipe' ? recipe : material;
    const name = (editor.current ?? editor.viewing)?.content.name || 'Untitled';
    if (confirming.action === 'erase') {
      return (
        <p>
          <strong>Erase {name} permanently?</strong> All its revisions are removed from this vault and cannot be
          brought back. Backups made before now still have it.
        </p>
      );
    }
    const users =
      confirming.kind === 'material'
        ? recipes.filter((r) => r.content.lines.some((line) => sameName(line.material, name))).length
        : 0;
    const standard = confirming.kind === 'material' && standardNamed(name);
    return (
      <p>
        <strong>Delete {name}?</strong> It moves to Deleted, below the list, where you can restore it or erase it for
        good.
        {editor.changed && ' Your unsaved changes to it are lost.'}
        {users > 0 &&
          ` ${users === 1 ? '1 recipe uses' : `${users} recipes use`} it, and will ${
            standard ? `use the standard ${standard} instead` : 'not find it'
          } until it is restored.`}
      </p>
    );
  };
  /** Below a saved recipe someone may change, in a team's vault: its batch sheet. */
  const batchSheetPart = () => {
    const current = recipe.current;
    if (!team || !current || recipe.viewing || !canEdit(access, current.collectionId, 'batch')) return null;
    const made = sheets.find((s) => s.content.recipe === current.recordId) ?? null;
    if (makingSheet) {
      return (
        <BatchSheetForm
          key={current.revisionId}
          recipe={current}
          sheet={made}
          sheets={sheets}
          recipes={recipes}
          onSaved={(saved) => {
            setSheets((list) => [saved, ...list.filter((s) => s.recordId !== saved.recordId)]);
            setMakingSheet(false);
          }}
          onCancel={() => setMakingSheet(false)}
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
        <button type="button" disabled={recipe.changed} onClick={() => setMakingSheet(true)}>
          Batch sheet…
        </button>
        {status && <span className="hint">{status}</span>}
      </div>
    );
  };

  /** Below a saved recipe someone may change, in a team's vault: moving it to another collection,
   * with its firings and batch sheets. */
  const movePart = () => {
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
          const moved = <Item extends { recordId: string; collectionId?: string }>(list: Item[], ids: string[]) =>
            list.map((item) => (ids.includes(item.recordId) ? { ...item, collectionId: to } : item));
          setRecipes((list) => moved(list, [current.recordId]));
          setFirings((list) => moved(list, ownFirings.map((f) => f.recordId)));
          setSheets((list) => moved(list, ownSheets.map((s) => s.recordId)));
          setMixes((list) => moved(list, ownMixes.map((m) => m.recordId)));
          recipe.rebase({ ...current, collectionId: to }, (draft) => draft);
        }}
      />
    );
  };

  /** Below a saved material someone may change, in a team's vault: moving it to another
   * collection. Recipes find it by name, so those elsewhere lose it for people who cannot open
   * where it goes. */
  const materialMovePart = () => {
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
          setMaterials((list) =>
            list.map((item) => (item.recordId === current.recordId ? { ...item, collectionId: to } : item))
          );
          material.rebase({ ...current, collectionId: to }, (draft) => draft);
        }}
      />
    );
  };

  /** Below a saved recipe: its firings, and logging another. */
  const firingsPart = () => {
    const current = recipe.current;
    if (!current || recipe.viewing) return null;
    // A body's firings include the glazes fired on it, as the log lists them.
    const count = firings.filter((f) => firingOf(f.content, current.recordId)).length;
    const mixCount = mixes.filter((m) => mixOf(m.content, current.recordId)).length;
    const show = (editing: FiringEditing | null) => {
      setFiringsOf(current.recordId);
      if (editing) editFiring(editing);
      setView('firings');
    };
    const showMixes = (editing: MixEditing | null) => {
      setMixesOf(current.recordId);
      if (editing) editMix(editing);
      setView('mixes');
    };
    return (
      <div className="row">
        {mixCount > 0 && (
          <button type="button" onClick={() => showMixes(null)}>
            Mixes ({mixCount})
          </button>
        )}
        {count > 0 && (
          <button type="button" onClick={() => show(null)}>
            Firings ({count})
          </button>
        )}
        {recipes.length > 1 && may(access, current.collectionId, 'chemistry') && (
          <button
            type="button"
            onClick={() =>
              leave('recipe', () => {
                setBlendFrom(current.recordId);
                setView('blend');
              })
            }
          >
            Blend…
          </button>
        )}
        {canEdit(access, current.collectionId, 'firing') && (
          <button
            type="button"
            onClick={() =>
              show({
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
            onClick={() => showMixes({ current: null, draft: newMix({ recipe: current }, new Date()) })}
          >
            Log a mix…
          </button>
        )}
      </div>
    );
  };

  const viewButton = (name: 'materials' | 'settings' | 'batches' | 'firings' | 'mixes', label: string) => (
    <button type="button" aria-pressed={view === name} onClick={() => setView(view === name ? 'recipes' : name)}>
      {label}
    </button>
  );

  return (
    <div className="shell">
      <header className="bar no-print">
        <span className="brand">Glaze Vault</span>
        <div className="bar-actions">
          {view === 'recipes' && may(access, shownIn, 'print') && (
            <button type="button" aria-expanded={printing} onClick={() => setPrinting(!printing)}>
              Print…
            </button>
          )}
          {viewButton('mixes', 'Mix log')}
          {viewButton('firings', 'Firing log')}
          {team && viewButton('batches', 'Batch sheets')}
          {viewButton('materials', 'Materials')}
          {viewButton('settings', 'Settings')}
          <SyncIndicator />
          {team && access && <span className="hint signed-in">{access.me.name}</span>}
          <button type="button" onClick={lock}>
            Lock
          </button>
        </div>
      </header>

      <div className="notices no-print">
        <OfflineNotice />
        {confirming && (
          <ConfirmNotice
            confirm={confirming.action === 'delete' ? 'Delete' : 'Erase permanently'}
            onConfirm={confirm}
            onCancel={() => setConfirming(null)}
          >
            {confirmText()}
          </ConfirmNotice>
        )}
        {pending && (
          <div className="notice warning" role="alertdialog" aria-labelledby="unsaved-title">
            <p id="unsaved-title">
              {pendingNames.map((name, i) => (
                <span key={name}>
                  {i > 0 && ' and '}
                  <strong>{name}</strong>
                </span>
              ))}{' '}
              {pendingNames.length > 1 ? 'have' : 'has'} changes that are not saved.
            </p>
            <div className="row">
              <button type="button" className="primary" autoFocus onClick={() => resolvePending('save')}>
                Save
              </button>
              <button type="button" onClick={() => resolvePending('discard')}>
                Discard changes
              </button>
              <button type="button" onClick={() => resolvePending('stay')}>
                Keep editing
              </button>
            </div>
          </div>
        )}
        {kept.recipe && recipe.changed && (
          <KeptNotice
            name={recipe.draft.name}
            onShow={view === 'recipes' ? undefined : () => setView('recipes')}
            onDiscard={() => {
              recipe.discard();
              setKept((k) => ({ ...k, recipe: false }));
            }}
          />
        )}
        {kept.material && material.changed && (
          <KeptNotice
            name={material.draft.name}
            onShow={view === 'materials' ? undefined : () => setView('materials')}
            onDiscard={() => {
              material.discard();
              setKept((k) => ({ ...k, material: false }));
            }}
          />
        )}
        {kept.firing && firingChanged && firing && (
          <KeptNotice
            name={firing.draft.recipeName ? `the firing of ${firing.draft.recipeName}` : 'a firing'}
            plain
            onShow={view === 'firings' ? undefined : () => setView('firings')}
            onDiscard={() => {
              editFiring(firing.current ? { current: firing.current, draft: firing.current.content } : null);
              setKept((k) => ({ ...k, firing: false }));
            }}
          />
        )}
        {kept.mix && mixChanged && mix && (
          <KeptNotice
            name="a mix"
            plain
            onShow={view === 'mixes' ? undefined : () => setView('mixes')}
            onDiscard={() => {
              editMix(mix.current ? { current: mix.current, draft: mix.current.content } : null);
              setKept((k) => ({ ...k, mix: false }));
            }}
          />
        )}
        {printing && view === 'recipes' && may(access, shownIn, 'print') && (
          <PrintOptions job={printJob} onPrint={print} onCancel={() => setPrinting(false)} />
        )}
        {update && !updateHidden && (
          <div className="notice" role="status">
            <p>Glaze Vault {update.version} is ready to install.</p>
            <div className="row">
              <button type="button" className="primary" disabled={installing} onClick={install}>
                {installing ? 'Installing…' : 'Install and restart'}
              </button>
              <button type="button" disabled={installing} onClick={() => setUpdateHidden(true)}>
                Later
              </button>
            </div>
          </div>
        )}
        {backupDue && (
          <div className="notice" role="status">
            <p>
              {lastBackup
                ? `Your last backup was ${Math.floor((Date.now() - lastBackup.at) / DAY)} days ago.`
                : 'Your recipes have not been backed up yet.'}{' '}
              A backup is an encrypted copy to keep away from this computer.
            </p>
            <div className="row">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setBackupError('');
                  backUp().catch((e) => setBackupError(errorText(e)));
                }}
              >
                Back up now…
              </button>
              <button type="button" onClick={() => setReminderHidden(true)}>
                Not now
              </button>
            </div>
            {backupError && <p role="alert" className="error">{backupError}</p>}
          </div>
        )}
      </div>

      {view === 'settings' && settings ? (
        <Settings
          onLeft={() => onLocked('left')}
          settings={settings}
          onSettings={saveSettings}
          lastBackup={lastBackup}
          backUp={backUp}
          recipes={recipes}
          materials={materials}
          firings={firings}
          status={status}
          update={update}
          onUpdate={(found) => {
            onUpdate(found);
            setUpdateHidden(false);
          }}
          onInstall={install}
          onNewRecoveryKey={setNewWords}
          onSwitchVault={(name) =>
            leave('all', async () => {
              setSwitchError('');
              try {
                await api.bringBack(name);
                onLocked('switched');
              } catch (e) {
                // The vault locks first, so a failed switch can leave it locked.
                const now = await api.status().catch(() => null);
                if (now && !now.unlocked) onLocked('manual');
                else setSwitchError(errorText(e));
              }
            })
          }
          switchError={switchError}
          onImport={(fileName, plan) => {
            setImporting({ fileName, plan });
            setView('import');
          }}
          onClose={() => setView('recipes')}
          access={access}
          onShared={setOrganizationWords}
          onTeamChanged={reloadAccess}
          limitFormulas={
            <LimitSets
              own={ownLimits}
              canCreate={!team || editableCollections(access, 'limits').length > 0}
              collection={team ? newIn('limits') : null}
              onSaved={(saved) =>
                setOwnLimits((list) => [saved, ...list.filter((l) => l.recordId !== saved.recordId)])
              }
              onDeleted={(recordId) => setOwnLimits((list) => list.filter((l) => l.recordId !== recordId))}
            />
          }
          prices={
            <PriceLists
              lists={priceLists}
              access={access}
              names={names}
              library={library}
              onSaved={(saved) => setPriceLists((lists) => [saved, ...lists.filter((l) => l.recordId !== saved.recordId)])}
            />
          }
        />
      ) : view === 'import' && importing ? (
        <Import
          fileName={importing.fileName}
          plan={importing.plan}
          recipes={recipes}
          materials={materials}
          collection={team ? newCollection : null}
          into={picker || undefined}
          onImported={({ recipes: newRecipes, materials: newMaterials }) => {
            const merge = <Content,>(list: Revision<Content>[], added: Revision<Content>[]) => [
              ...added,
              ...list.filter((head) => !added.some((a) => a.recordId === head.recordId))
            ];
            setRecipes((list) => merge(list, newRecipes));
            setMaterials((list) => merge(list, newMaterials));
            // A record open in an editor that got a new revision moves on to it, keeping any edits.
            newRecipes.forEach((saved) => recipe.rebase(saved, (draft) => draft));
            newMaterials.forEach((saved) => material.rebase(saved, (draft) => draft));
          }}
          onClose={() => {
            setImporting(null);
            setView('settings');
          }}
        />
      ) : view === 'compare' && comparing ? (
        <Compare
          recipes={recipes.filter((r) => may(access, r.collectionId, 'chemistry'))}
          unsaved={recipe.changed ? { recordId: recipe.current?.recordId ?? null, content: recipe.draft } : null}
          library={library}
          initial={comparing}
          onClose={() => setView('recipes')}
        />
      ) : view === 'blend' ? (
        <Blend
          recipes={recipes.filter((r) => may(access, r.collectionId, 'chemistry'))}
          library={library}
          initial={blendFrom}
          canSave={mayCreate}
          canPrint={(ids) => ids.every((id) => may(access, recipes.find((r) => r.recordId === id)?.collectionId, 'print'))}
          onSave={async (content) => {
            const saved = await api.saveRecipe(null, content, newCollection);
            setRecipes((list) => [saved, ...list]);
          }}
          onClose={() => setView('recipes')}
        />
      ) : view === 'fit' ? (
        <Fit
          recipe={shownRecipe}
          library={library}
          sets={limitSets(ownLimits)}
          initialSet={limitChoice}
          onUse={
            !recipe.viewing && canEdit(access, recipe.current ? recipe.current.collectionId : newCollection)
              ? (lines) => {
                  recipe.edit({ ...recipe.draft, lines });
                  setView('recipes');
                }
              : undefined
          }
          onSaveNew={
            mayCreate
              ? async (content) => {
                  const saved = await api.saveRecipe(null, content, newCollection);
                  setRecipes((list) => [saved, ...list]);
                }
              : undefined
          }
          onClose={() => setView('recipes')}
        />
      ) : view === 'firings' ? (
        <FiringLog
          firings={firings}
          mixes={mixes}
          recipes={recipes}
          access={access}
          editing={firing}
          onEdit={editFiring}
          forRecipe={firingsOf}
          onForRecipe={setFiringsOf}
          onSaved={(saved) => setFirings((list) => [saved, ...list.filter((f) => f.recordId !== saved.recordId)])}
          onErased={(recordId) => setFirings((list) => list.filter((f) => f.recordId !== recordId))}
        />
      ) : view === 'mixes' ? (
        <MixLog
          mixes={mixes}
          recipes={recipes}
          sheets={sheets}
          access={access}
          editing={mix}
          onEdit={editMix}
          forRecipe={mixesOf}
          onForRecipe={setMixesOf}
          onSaved={(saved) => setMixes((list) => [saved, ...list.filter((m) => m.recordId !== saved.recordId)])}
          onErased={(recordId) => setMixes((list) => list.filter((m) => m.recordId !== recordId))}
        />
      ) : view === 'batches' && access ? (
        <BatchSheets
          sheets={sheets}
          access={access}
          names={names}
          current={sheet}
          onOpen={setSheet}
          mixCount={sheet ? mixes.filter((m) => m.content.sheet === sheet.recordId).length : 0}
          onMixes={(of, logging) => {
            setMixesOf(of.content.recipe);
            if (logging) editMix({ current: null, draft: newMix({ sheet: of }, new Date()) });
            setView('mixes');
          }}
          onPrint={(size, unit) => print({ kind: 'batch', size, unit })}
          onDeleted={(gone) => {
            setSheets((list) => list.filter((s) => s.recordId !== gone.recordId));
            setSheet(null);
          }}
          onSaved={(saved) => {
            setSheets((list) => [saved, ...list.filter((s) => s.recordId !== saved.recordId)]);
            setSheet(saved);
          }}
        />
      ) : view === 'materials' ? (
        <Materials
          materials={materials}
          recipes={recipes}
          editor={material}
          saving={saving}
          error={materialError}
          onOpen={openMaterial}
          onSave={() => saveMaterial()}
          onUseRevision={() => takeRevision('material', material)}
          deleted={deletedMaterials}
          onOpenDeleted={(gone) => openDeleted(records.material, gone)}
          onDelete={() => setConfirming({ action: 'delete', kind: 'material' })}
          onRestore={() => {
            const name = material.viewing!.content.name;
            const clash = materials.find((m) => sameName(m.content.name, name));
            void restoreRecord(records.material, clash?.content.name);
          }}
          onErase={() => setConfirming({ action: 'erase', kind: 'material' })}
          onKeepVersion={(keep) => keepVersion(records.material, keep)}
          renameInRecipes={renameInRecipes}
          onRenameInRecipes={setRenameInRecipes}
          readOnly={!canEdit(access, material.current ? material.current.collectionId : newIn('material'), 'material')}
          moveTo={materialMovePart()}
          canCreate={!team || editableCollections(access, 'material').length > 0}
          newIn={
            (team && access && (
              <CollectionPicker
                access={access}
                names={names}
                kind="material"
                value={newIn('material')}
                onChange={setNewCollection}
              />
            )) ||
            undefined
          }
        />
      ) : (
        <RecipeEditor
          recipes={recipes}
          editor={recipe}
          library={library}
          analysis={analysis}
          saving={saving}
          error={error}
          onOpen={openRecipe}
          onSave={() => saveRecipe()}
          onUseRevision={() => takeRevision('recipe', recipe)}
          deleted={deletedRecipes}
          onOpenDeleted={(gone) => openDeleted(records.recipe, gone)}
          onDelete={() => setConfirming({ action: 'delete', kind: 'recipe' })}
          onRestore={() => void restoreRecord(records.recipe)}
          onErase={() => setConfirming({ action: 'erase', kind: 'recipe' })}
          onKeepVersion={(keep) => keepVersion(records.recipe, keep)}
          onCompareFork={
            chemistry && recipe.current
              ? (revisionId) => {
                  const recordId = recipe.current!.recordId;
                  setComparing([
                    { recordId, number: null },
                    { recordId, number: null, revisionId }
                  ]);
                  setView('compare');
                }
              : undefined
          }
          onCompare={
            canCompare
              ? (number) => {
                  setComparing(compareFrom(number));
                  setView('compare');
                }
              : undefined
          }
          readOnly={!canEdit(access, recipe.current ? recipe.current.collectionId : newCollection)}
          canCreate={mayCreate}
          groups={team && access ? byCollection(recipes, access, names) : undefined}
          newIn={picker || undefined}
          withoutChemistry={!chemistry}
          limits={
            <>
              <CostLine lines={shownRecipe.lines} list={prices} />
              <LimitsPanel
                sets={limitSets(ownLimits)}
                chosen={limitChoice}
                onChoose={setLimitChoice}
                umf={analysis?.result?.umf ?? null}
              />
              {analysis?.result && (
                <button type="button" className="fit-button" onClick={() => setView('fit')}>
                  Fit to a formula…
                </button>
              )}
            </>
          }
          batchSheet={
            <>
              {firingsPart()}
              {chemistry && batchSheetPart()}
              {movePart()}
            </>
          }
        />
      )}

      {view === 'blend' || view === 'fit' ? null : view === 'batches' && sheet ? (
        <PrintView job={printJob} content={sheet.content} saved={sheet} changed={false} analysis={null} sheet />
      ) : (
        <PrintView
          job={printJob}
          content={shownRecipe}
          saved={recipe.viewing ?? recipe.current}
          changed={!recipe.viewing && recipe.changed}
          analysis={analysis}
          prices={prices}
          own={library.own}
        />
      )}
    </div>
  );
}

function KeptNotice({
  name,
  plain = false,
  onShow,
  onDiscard
}: {
  name: string;
  /** The name is a phrase, not a record's name to show in bold. */
  plain?: boolean;
  onShow?: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="notice" role="status">
      <p>
        These are your unsaved changes to {plain ? name : <strong>{name || 'Untitled'}</strong>} from last time. Save
        them, or discard them.
      </p>
      <div className="row">
        {onShow && (
          <button type="button" className="primary" onClick={onShow}>
            Show them
          </button>
        )}
        <button type="button" onClick={onDiscard}>
          Discard changes
        </button>
      </div>
    </div>
  );
}

function PrintOptions({
  job,
  onPrint,
  onCancel
}: {
  job: PrintJob;
  onPrint: (job: PrintJob) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<PrintJob['kind']>(job.kind);
  const [size, setSize] = useState(job.kind === 'batch' ? String(job.size) : '1000');
  const [unit, setUnit] = useState<BatchUnit>(job.kind === 'batch' ? job.unit : 'g');
  const amount = amountOf(size);
  const ready = kind === 'recipe' || (Number.isFinite(amount) && amount > 0);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (ready) onPrint(kind === 'recipe' ? { kind } : { kind, size: amount, unit });
  };

  return (
    <form className="notice" onSubmit={submit}>
      <fieldset className="print-options">
        <legend>Print</legend>
        <label className="check">
          <input type="radio" name="print-kind" checked={kind === 'recipe'} onChange={() => setKind('recipe')} />
          The recipe, with its unity formula
        </label>
        <label className="check">
          <input type="radio" name="print-kind" checked={kind === 'batch'} onChange={() => setKind('batch')} />
          A batch sheet for weighing out
        </label>
        {kind === 'batch' && (
          <div className="row batch-size">
            <label htmlFor="batch-size">Batch size</label>
            <input
              id="batch-size"
              inputMode="decimal"
              value={size}
              onChange={(e) => setSize(e.target.value)}
              aria-invalid={!ready}
            />
            <select aria-label="Unit" value={unit} onChange={(e) => setUnit(e.target.value as BatchUnit)}>
              {BATCH_UNITS.map((u) => (
                <option key={u.unit} value={u.unit}>
                  {u.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </fieldset>
      <div className="row">
        <button type="submit" className="primary" disabled={!ready}>
          Print
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Notes in the audit log that a record was opened. A note that fails does not stop the page. */
function useOpened(kind: Kind, recordId: string | undefined) {
  useEffect(() => {
    if (recordId) api.note({ action: 'opened', kind, record: recordId }).catch(() => {});
  }, [kind, recordId]);
}
