import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  api,
  errorText,
  onEvent,
  type Access,
  type Draft,
  type DraftPart,
  type Kind,
  type LastBackup,
  type MaterialHead,
  type RecipeHead,
  type Revision,
  type Settings as VaultSettings,
  type UpdateInfo,
  type VaultChanged,
  type VaultStatus
} from '../api';
import type { BatchSheet } from '../batch';
import { isBody } from '../body';
import { analyse, materialLibrary, sameName, type MaterialContent, type RecipeContent } from '../chemistry';
import { localDate } from '../export';
import { sameFiring, type Firing, type FiringContent } from '../firing';
import type { ImportPlan } from '../importFormats';
import type { LimitsContent } from '../limits';
import { newMix, sameMix, type Mix, type MixContent } from '../mix';
import { offered } from '../phone';
import { priceListFor, type PricesContent } from '../prices';
import { printOut } from '../printing';
import { byCollection, canEdit, defaultCollection, editableCollections, may, onlyWeighs } from '../team';
import { DRAFT_DELAY_MS, followed, useDraftSync } from '../useDraftSync';
import { restorePart, useEditor, type Editor } from '../useEditor';
import { useFieldAboveKeyboard } from '../useFieldAboveKeyboard';
import { BACKGROUND_GRACE_SECONDS, useBackgroundLock, useIdleLock } from '../useIdleLock';
import { useOpened } from '../useOpened';
import { usePhoneBackups } from '../usePhoneBackups';
import { BatchSheets } from './BatchSheets';
import { Blend } from './Blend';
import { Compare, type Side } from './Compare';
import { ConfirmNotice } from './Deleted';
import { FiringLog, type FiringEditing } from './FiringLog';
import { Fit } from './Fit';
import { Import } from './Import';
import { LimitSets, LimitsPanel, limitSets, savedLimitChoice } from './Limits';
import { EMPTY_MATERIAL, Materials, sameMaterial } from './Materials';
import { MixLog, type MixEditing } from './MixLog';
import { OfflineNotice } from './OfflineNotice';
import { CostLine, PriceLists } from './Prices';
import { PrintView, type PrintJob } from './PrintView';
import { EMPTY_RECIPE, RecipeEditor, sameRecipe } from './RecipeEditor';
import {
  MaterialMoveSection,
  RecipeBatchSheetSection,
  RecipeLogsAndToolsRow,
  RecipeMoveSection
} from './RecipeExtras';
import { RecoverySheet } from './RecoverySheet';
import {
  deleteOrEraseText,
  KeptNotice,
  PhoneNav,
  PrintOptions,
  RecipesHeader,
  type ShellView,
  UnsavedDialog
} from './RecipesShell';
import { Settings } from './Settings';
import { CollectionPicker } from './Team';

export { DRAFT_DELAY_MS };

const DAY = 24 * 60 * 60 * 1000;
type Scope = 'recipe' | 'material' | 'all';

/** One kind's lists and editor, for what deleting, restoring and erasing do the same for both. */
interface Records<Content> {
  kind: 'recipe' | 'material';
  editor: Editor<Content>;
  setHeads: Dispatch<SetStateAction<Revision<Content>[]>>;
  setDeleted: Dispatch<SetStateAction<Revision<Content>[]>>;
  setError: (error: string) => void;
}

export type LockReason = 'manual' | 'idle' | 'idle-with-draft' | 'away' | 'away-with-draft' | 'switched' | 'left';

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
  const [view, setView] = useState<ShellView>('recipes');
  // A phone shows a bottom bar, and leaves running a vault it joined to a computer (ADR 31).
  const phone = status.platform !== 'desktop';
  const [replica, setReplica] = useState(false);
  useEffect(() => {
    if (phone) api.networkStatus().then((network) => setReplica(!!network?.replica), () => {});
  }, [phone]);
  const shows = offered(status.platform, replica);
  useFieldAboveKeyboard(phone);

  const [firings, setFirings] = useState<Firing[]>([]);
  const [firing, setFiring] = useState<FiringEditing | null>(null);
  const [firingsOf, setFiringsOf] = useState<string | null>(null);
  const [mixes, setMixes] = useState<Mix[]>([]);
  const [mix, setMix] = useState<MixEditing | null>(null);
  const [mixesOf, setMixesOf] = useState<string | null>(null);
  const [blendFrom, setBlendFrom] = useState<string | null>(null);
  const [ownLimits, setOwnLimits] = useState<Revision<LimitsContent>[]>([]);
  const [limitChoice, setLimitChoice] = useState(savedLimitChoice);
  const [priceLists, setPriceLists] = useState<Revision<PricesContent>[]>([]);
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
  const [access, setAccess] = useState<Access | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [newCollection, setNewCollection] = useState<string | null>(null);
  const [reminderHidden, setReminderHidden] = useState(false);
  const [updateHidden, setUpdateHidden] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [printJob, setPrintJob] = useState<PrintJob>({ kind: 'recipe' });
  const [printRequest, setPrintRequest] = useState(0);

  const firingChanged = !!firing && (!firing.current || !sameFiring(firing.current.content, firing.draft));
  const firingPart: DraftPart<FiringContent> | undefined =
    firing && firingChanged
      ? { recordId: firing.current?.recordId ?? null, revisionId: firing.current?.revisionId ?? null, content: firing.draft }
      : undefined;
  const editFiring = (next: FiringEditing | null) => {
    if (!next || next.current !== firing?.current) setKept((k) => ({ ...k, firing: false }));
    setFiring(next);
  };
  const firingPartRef = useRef(firingPart);
  firingPartRef.current = firingPart;

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

  const unsaved: Draft | null =
    recipe.part || material.part || firingPart || mixPart
      ? { recipe: recipe.part, material: material.part, firing: firingPart, mix: mixPart }
      : null;
  const { writeDraft, markDraftLoaded } = useDraftSync(loaded, unsaved);

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
        setFiring((open) => followed(open, allFirings));
        setMix((open) => followed(open, allMixes));
        setOwnLimits(limits);
      })
      .catch((e) => setError(errorText(e)));
  };

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
      if (onlyWeighs(now)) setView('batches');
      setMaterials(ownMaterials);
      setDeletedRecipes(gone);
      setDeletedMaterials(goneMaterials);
      setSettings(settings);
      setLastBackup(last);
      markDraftLoaded(!!draft);
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
  }, []);

  useEffect(() => {
    if (printRequest) printOut().catch((e) => setError(errorText(e)));
  }, [printRequest]);

  useOpened('recipe', recipe.current?.recordId);
  useOpened('material', material.current?.recordId);
  useOpened('batch', sheet?.recordId);
  useOpened('firing', firing?.current?.recordId);
  useOpened('mix', mix?.current?.recordId);

  const library = useMemo(() => materialLibrary(materials.map((m) => m.content)), [materials]);
  const shownRecipe = recipe.viewing?.content ?? recipe.draft;
  const prices =
    priceListFor(priceLists, (recipe.viewing ?? recipe.current)?.collectionId ?? newCollection)?.content ?? null;
  const analysis = useMemo(
    () => analyse(shownRecipe.lines, library, { body: isBody(shownRecipe.type) }),
    [shownRecipe.lines, shownRecipe.type, library]
  );

  const lockBySelf = async (reason: 'idle' | 'away') => {
    try {
      if (unsaved) {
        await writeDraft(() => api.lockWithDraft(unsaved));
        onLocked(`${reason}-with-draft`);
      } else {
        await api.lock();
        onLocked(reason);
      }
    } catch {
      await api.lock().catch(() => {});
      onLocked(reason);
    }
  };
  useIdleLock(settings?.autoLock && !newWords ? settings.autoLockMinutes : null, () => lockBySelf('idle'));
  useBackgroundLock(status.platform !== 'desktop' && !newWords ? BACKGROUND_GRACE_SECONDS : null, () =>
    lockBySelf('away')
  );

  const unsavedIn = (scope: Scope) =>
    (scope !== 'material' && recipe.changed) || (scope !== 'recipe' && material.changed);
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

  const team = !!access?.team;
  const newIn = (kind: Kind) =>
    !team || canEdit(access, newCollection, kind) ? newCollection : defaultCollection(access, kind);

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

  const renameMaterial = async (oldName: string, name: string) => {
    const rename = (content: RecipeContent): RecipeContent => ({
      ...content,
      lines: content.lines.map((line) => (sameName(line.material, oldName) ? { ...line, material: name } : line))
    });
    const all = recipes.filter((r) => r.content.lines.some((line) => sameName(line.material, oldName)));
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

  const openDeleted = <Content,>(r: Records<Content>, gone: Revision<Content>) =>
    leave(r.kind, () => {
      r.editor.look(gone);
      r.setError('');
      setKept((k) => ({ ...k, [r.kind]: false }));
    });

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

  const takeRevision = <Content,>(scope: 'recipe' | 'material', editor: Editor<Content>) => {
    const content = editor.viewing!.content;
    leave(scope, () => editor.edit(content));
  };

  const phoneBackups = usePhoneBackups(status.platform !== 'desktop', (made) => {
    if (made.photos) setLastBackup({ at: made.at, fileName: made.fileName });
  });

  const backUp = async () => {
    const saved = await api.backUp(`Glaze Vault backup ${localDate(new Date())}.gvbackup`);
    if (saved) setLastBackup(saved);
  };

  const saveSettings = async (next: VaultSettings) => {
    await api.setSettings(next);
    setSettings(next);
    await phoneBackups.refresh();
  };

  const install = () =>
    leave('all', async () => {
      setInstalling(true);
      try {
        await api.installUpdate();
      } catch (e) {
        setInstalling(false);
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

  const mayCreate = !team || editableCollections(access).length > 0;
  const picker = team && access && (
    <CollectionPicker access={access} names={names} value={newCollection} onChange={setNewCollection} />
  );
  const reminderDays = settings?.backupReminderDays ?? 0;
  const backupDue =
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
  const shownIn = recipe.current ? recipe.current.collectionId : newCollection;
  const chemistry = may(access, shownIn, 'chemistry');
  const canCompare = chemistry && !!compareFrom();

  return (
    <div className={phone ? 'shell phone' : 'shell'}>
      <RecipesHeader
        view={view}
        onView={setView}
        canPrint={may(access, shownIn, 'print')}
        printing={printing}
        onTogglePrint={() => setPrinting(!printing)}
        team={team}
        signedInName={team && access ? access.me.name : null}
        onLock={lock}
      />

      {phone && <PhoneNav view={view} onView={setView} team={team} onLock={lock} />}

      <div className="notices no-print">
        <OfflineNotice />
        {confirming && (
          <ConfirmNotice
            confirm={confirming.action === 'delete' ? 'Delete' : 'Erase permanently'}
            onConfirm={confirm}
            onCancel={() => setConfirming(null)}
          >
            {confirming.kind === 'recipe'
              ? deleteOrEraseText(confirming.action, 'recipe', recipe, recipes)
              : deleteOrEraseText(confirming.action, 'material', material, recipes)}
          </ConfirmNotice>
        )}
        {pending && <UnsavedDialog names={pendingNames} onResolve={(choice) => void resolvePending(choice)} />}
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
              {phoneBackups.status?.last && !phoneBackups.status.last.photos
                ? "The backups this phone keeps leave your photos out, to fit the phone's own backup. Save a whole one somewhere else."
                : 'A backup is an encrypted copy to keep away from this computer.'}
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
          offered={shows}
          onLeft={() => onLocked('left')}
          settings={settings}
          onSettings={saveSettings}
          lastBackup={lastBackup}
          phoneBackups={phoneBackups.status}
          phoneBackupError={phoneBackups.error}
          backUp={backUp}
          recipes={recipes}
          materials={materials}
          firings={firings}
          mixes={mixes}
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
          phone={phone}
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
          moveTo={
            <MaterialMoveSection
              team={team}
              access={access}
              names={names}
              material={material}
              recipes={recipes}
              onMoved={(current, to) => {
                setMaterials((list) =>
                  list.map((item) => (item.recordId === current.recordId ? { ...item, collectionId: to } : item))
                );
                material.rebase({ ...current, collectionId: to }, (draft) => draft);
              }}
            />
          }
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
              {analysis?.result?.umf && (
                <button type="button" className="fit-button" onClick={() => setView('fit')}>
                  Fit to a formula…
                </button>
              )}
            </>
          }
          batchSheet={
            <>
              <RecipeLogsAndToolsRow
                recipe={recipe}
                recipesCount={recipes.length}
                access={access}
                firings={firings}
                mixes={mixes}
                onShowFirings={(recordId, editing) => {
                  setFiringsOf(recordId);
                  if (editing || !firingChanged) editFiring(editing);
                  setView('firings');
                }}
                onShowMixes={(recordId, editing) => {
                  setMixesOf(recordId);
                  if (editing || !mixChanged) editMix(editing);
                  setView('mixes');
                }}
                onBlend={(recordId) =>
                  leave('recipe', () => {
                    setBlendFrom(recordId);
                    setView('blend');
                  })
                }
              />
              {chemistry && (
                <RecipeBatchSheetSection
                  team={team}
                  access={access}
                  recipe={recipe}
                  recipes={recipes}
                  sheets={sheets}
                  making={makingSheet}
                  onMaking={setMakingSheet}
                  onSaved={(saved) => {
                    setSheets((list) => [saved, ...list.filter((s) => s.recordId !== saved.recordId)]);
                    setMakingSheet(false);
                  }}
                />
              )}
              <RecipeMoveSection
                team={team}
                access={access}
                names={names}
                recipe={recipe}
                firings={firings}
                sheets={sheets}
                mixes={mixes}
                onMoved={(to, ids) => {
                  const current = recipe.current!;
                  const moved = <Item extends { recordId: string; collectionId?: string }>(list: Item[], movedIds: string[]) =>
                    list.map((item) => (movedIds.includes(item.recordId) ? { ...item, collectionId: to } : item));
                  setRecipes((list) => moved(list, [current.recordId]));
                  setFirings((list) => moved(list, ids.firings));
                  setSheets((list) => moved(list, ids.sheets));
                  setMixes((list) => moved(list, ids.mixes));
                  recipe.rebase({ ...current, collectionId: to }, (draft) => draft);
                }}
              />
            </>
          }
        />
      )}

      {view === 'blend' || view === 'fit' || view === 'mixes' ? null : view === 'batches' && sheet ? (
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
