// Reading recipes and materials from other programs' files (docs/adr/0010-importing.md). There is
// no standard for glaze recipes; these are the formats that are shared in practice:
//
// - Glaze Vault's own JSON export, and its recipe and material CSVs.
// - Digitalfire Insight XML, which Insight-live and Glazy both write: <recipe> with <recipeline
//   material amount>, and Glazy's <material> with <oxide symbol percent>.
// - GlazeChem text: .glz recipes and .mat materials, "key = value" lines.
// - A materials CSV with a column of names and one per oxide, as supplier data sheets are typed
//   up and as Insight-live imports: a header of oxide symbols, optionally with LOI, Kind, Notes.
import {
  amountOf,
  FORMULA_PARTS,
  MATERIAL_CATEGORIES,
  normalize,
  OXIDES,
  type FormulaLine,
  type MaterialCategory,
  type MaterialContent,
  type OxideLine,
  type RecipeContent,
  type RecipeLine
} from './chemistry';
import { EXPORT_FORMAT } from './export';
import {
  ATMOSPHERES,
  details,
  optionNamed,
  parseTags,
  RECIPE_TYPES,
  SURFACES,
  TRANSPARENCIES,
  type RecipeDetails
} from './recipeFields';

/** What a file holds, read and ready to choose from. */
export interface ImportPlan {
  /** The format it was read as, for the person. */
  format: string;
  recipes: RecipeContent[];
  materials: MaterialContent[];
  /** What could not be read, or was left out. */
  warnings: string[];
}

/** A file that cannot be read at all. The message is for the person. */
export class ImportError extends Error {}

/** Reads a file by its contents, with its name as a hint. */
export function readImport(fileName: string, text: string): ImportPlan {
  const body = text.replace(/^﻿/, '');
  const start = body.trimStart();
  const extension = fileName.toLowerCase().split('.').pop() ?? '';
  let plan: ImportPlan;
  if (start.startsWith('{')) plan = readJson(body);
  else if (start.startsWith('<')) plan = readInsightXml(body);
  else if (/^\s*(filetype\s*=\s*GlazeChem|name\s*=)/im.test(body.slice(0, 2000)) || ['glz', 'mat'].includes(extension)) {
    plan = readGlazeChem(body);
  } else plan = readCsv(body);
  if (!plan.recipes.length && !plan.materials.length) {
    throw new ImportError(`No recipes or materials were found in ${fileName}.`);
  }
  return dedupeMaterials(plan);
}

// --- Glaze Vault JSON ---------------------------------------------------------------------------

function readJson(text: string): ImportPlan {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ImportError('This JSON file could not be read: it is damaged or not JSON.');
  }
  const file = data as { format?: unknown; recipes?: unknown; materials?: unknown };
  if (file.format !== EXPORT_FORMAT) {
    throw new ImportError('This JSON file is not a Glaze Vault export. Glaze Vault reads its own JSON exports.');
  }
  const warnings: string[] = [];
  const str = (value: unknown) => (typeof value === 'string' ? value : value == null ? '' : String(value));
  const recipes = (Array.isArray(file.recipes) ? file.recipes : []).map((r: Record<string, unknown>) => ({
    name: str(r.name),
    ...readDetails({
      type: str(r.type),
      cone: str(r.cone),
      atmosphere: str(r.atmosphere),
      surface: str(r.surface),
      transparency: str(r.transparency),
      color: str(r.color),
      tags: Array.isArray(r.tags) ? r.tags.map(str).join(', ') : str(r.tags),
      gravity: str(r.gravity),
      viscosity: str(r.viscosity)
    }),
    lines: (Array.isArray(r.lines) ? r.lines : []).map((l: Record<string, unknown>) => ({
      material: str(l.material),
      amount: str(l.amount),
      ...(l.addition === true ? { addition: true } : {})
    })),
    notes: str(r.notes)
  }));
  const materials = (Array.isArray(file.materials) ? file.materials : []).map(
    (m: Record<string, unknown>): MaterialContent => ({
      name: str(m.name),
      category: categoryOf(str(m.category)),
      ...(m.basis === 'formula' ? { basis: 'formula' as const } : {}),
      oxides: (Array.isArray(m.oxides) ? m.oxides : []).map((o: Record<string, unknown>) => ({
        oxide: str(o.oxide),
        percent: str(o.percent)
      })),
      loi: str(m.loi),
      ...(Array.isArray(m.formula)
        ? { formula: m.formula.map((f: Record<string, unknown>) => ({ oxide: str(f.oxide), moles: str(f.moles) })) }
        : {}),
      notes: str(m.notes)
    })
  );
  return { format: 'Glaze Vault export (JSON)', recipes: recipes.map(withLine), materials, warnings };
}

// --- Insight XML --------------------------------------------------------------------------------

/** Elements by name, ignoring case: Insight and Glazy do not agree on it. */
function elements(root: Element | Document, name: string): Element[] {
  return [...root.getElementsByTagName('*')].filter((element) => element.localName.toLowerCase() === name);
}

function attribute(element: Element, name: string): string {
  const found = [...element.attributes].find((a) => a.name.toLowerCase() === name);
  return found?.value.trim() ?? '';
}

function readInsightXml(text: string): ImportPlan {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new ImportError('This XML file could not be read: it is damaged or not XML.');
  }
  const warnings: string[] = [];
  const recipes = elements(doc, 'recipe').map((recipe): RecipeContent => {
    const name = attribute(recipe, 'name');
    const lines = elements(recipe, 'recipeline');
    const units = new Set(lines.map((line) => attribute(line, 'unitabbr')).filter(Boolean));
    if (units.size > 1) {
      warnings.push(`${name || 'A recipe'} mixes units (${[...units].join(', ')}): its amounts were converted.`);
    }
    const notes = [
      attribute(recipe, 'codenum') && `Code: ${attribute(recipe, 'codenum')}`,
      attribute(recipe, 'date') && `Dated ${attribute(recipe, 'date')}`,
      ...['notes', 'comments', 'comment'].flatMap((tag) => elements(recipe, tag).map((e) => e.textContent?.trim() ?? '')),
      ...elements(recipe, 'url').map((url) => [attribute(url, 'descrip'), attribute(url, 'url')].filter(Boolean).join(': '))
    ].filter(Boolean);
    return {
      name,
      ...readDetails({ tags: attribute(recipe, 'keywords') }),
      lines: lines.map((line) => {
        const amount = attribute(line, 'amount');
        const conversion = Number(attribute(line, 'conversion') || '1');
        const converted = units.size > 1 && Number.isFinite(conversion) ? Number(amount) * conversion : Number(amount);
        return {
          material: attribute(line, 'material'),
          amount: tidy(Number.isFinite(converted) ? String(converted) : amount),
          ...(['1', 'true', 'yes'].includes(attribute(line, 'added').toLowerCase()) ? { addition: true } : {})
        };
      }),
      notes: notes.join('\n')
    };
  });
  const materials = elements(doc, 'material')
    .filter((material) => elements(material, 'oxide').length || attribute(material, 'loi'))
    .map((material): MaterialContent => {
      const name = attribute(material, 'name');
      const volatile = elements(material, 'volatile').find((v) => attribute(v, 'symbol').toUpperCase() === 'LOI');
      const oxides: OxideLine[] = [];
      for (const oxide of elements(material, 'oxide')) {
        const symbol = oxideNamed(attribute(oxide, 'symbol'));
        const percent = attribute(oxide, 'percent');
        if (!percent || Number(percent) === 0) continue;
        if (symbol && OXIDES.includes(symbol)) oxides.push({ oxide: symbol, percent: tidy(percent) });
        else warnings.push(`${name}: ${attribute(oxide, 'symbol')} is not an oxide Glaze Vault knows, so it was left out.`);
      }
      return {
        name,
        category: 'material',
        oxides,
        loi: tidy(volatile ? attribute(volatile, 'percent') : attribute(material, 'loi')),
        notes: attribute(material, 'descrip')
      };
    });
  return { format: 'Insight XML', recipes: recipes.map(withLine), materials, warnings };
}

// --- GlazeChem ----------------------------------------------------------------------------------

/** One record's "key = value" lines, in order. */
type GlazeChemRecord = [key: string, value: string][];

/** Records of "key = value" lines, each starting at a name. Notes run over lines starting "|". */
function glazeChemRecords(text: string): GlazeChemRecord[] {
  const records: GlazeChemRecord[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const at = raw.indexOf('=');
    if (at < 0) continue;
    const key = raw.slice(0, at).trim().toLowerCase();
    if (key === 'name') records.push([]);
    records.at(-1)?.push([key, raw.slice(at + 1).trim()]);
  }
  return records;
}

const values = (record: GlazeChemRecord, key: string) => record.filter(([k]) => k === key).map(([, v]) => v);

const noteText = (lines: string[]) =>
  lines
    .map((line) => line.replace(/^\|/, '').trimEnd())
    .join('\n')
    .trim();

function readGlazeChem(text: string): ImportPlan {
  const warnings: string[] = [];
  const recipes: RecipeContent[] = [];
  const materials: MaterialContent[] = [];
  for (const record of glazeChemRecords(text)) {
    const first = (key: string) => values(record, key)[0] ?? '';
    const name = first('name');
    if (values(record, 'formula').length) {
      materials.push(glazeChemMaterial(name, first('formula'), first('type'), record, warnings));
      continue;
    }
    // Components and additions each have their amount on the line after them.
    const lines: RecipeLine[] = [];
    for (const [key, value] of record) {
      if (key === 'component') lines.push({ material: value, amount: '' });
      else if (key === 'addition') lines.push({ material: value, amount: '', addition: true });
      else if ((key === 'amount' || key === 'addamount') && lines.length) lines[lines.length - 1].amount = tidy(value);
    }
    if (first('by_vol').toLowerCase() === 'y') {
      warnings.push(`${name || 'A recipe'} gives its amounts by volume, not weight.`);
    }
    // Details that match Glaze Vault's are kept as details, and the rest in the notes.
    const found = readDetails({
      cone: first('range'),
      atmosphere: first('firetype'),
      type: first('type'),
      color: first('color'),
      surface: first('quality'),
      transparency: first('transparency')
    });
    const about = [
      !found.atmosphere && first('firetype'),
      !found.type && first('type'),
      !found.surface && first('quality'),
      !found.transparency && first('transparency'),
      first('source') && `Source: ${first('source')}`,
      first('date') && `Dated ${first('date')}`
    ].filter(Boolean);
    const notes = [about.join('. '), noteText(values(record, 'note'))].filter(Boolean).join('\n\n');
    recipes.push({ name, ...found, lines, notes });
  }
  return { format: 'GlazeChem', recipes: recipes.map(withLine), materials, warnings };
}

const VOLATILES = ['LOI', 'H2O', 'CO2', 'SO3'];

function glazeChemMaterial(
  name: string,
  formula: string,
  type: string,
  record: GlazeChemRecord,
  warnings: string[]
): MaterialContent {
  const tokens = formula.split(/\s+/).filter(Boolean);
  const percent = tokens[0] === '%';
  if (percent) tokens.shift();
  // Amounts come before their oxide, and an oxide with none has one.
  const parts: { symbol: string; amount: number }[] = [];
  let pending: number | null = null;
  for (const token of tokens) {
    const number = Number(token);
    if (Number.isFinite(number)) pending = number;
    else {
      parts.push({ symbol: token, amount: pending ?? 1 });
      pending = null;
    }
  }
  const left: string[] = [];
  const notes = [noteText(values(record, 'annote')), noteText(values(record, 'note'))].filter(Boolean);
  const content: MaterialContent = { name, category: categoryOf(type), oxides: [], loi: '', notes: '' };
  if (percent) {
    let loi = 0;
    for (const { symbol, amount } of parts) {
      const oxide = oxideNamed(symbol);
      if (VOLATILES.includes(symbol.toUpperCase())) loi += amount;
      else if (oxide && OXIDES.includes(oxide)) content.oxides.push({ oxide, percent: tidy(String(amount)) });
      else left.push(`${amount} ${symbol}`);
    }
    content.loi = loi ? tidy(String(Number(loi.toFixed(4)))) : '';
  } else {
    content.basis = 'formula';
    content.formula = [];
    for (const { symbol, amount } of parts) {
      const part = FORMULA_PARTS.find((p) => p.toLowerCase() === symbol.toLowerCase());
      if (part) content.formula.push({ oxide: part, moles: tidy(String(amount)) } satisfies FormulaLine);
      else left.push(`${amount} ${symbol}`);
    }
  }
  if (left.length) {
    warnings.push(`${name}: ${left.join(', ')} ${left.length === 1 ? 'is' : 'are'} not an oxide Glaze Vault knows, so left out.`);
    notes.unshift(`GlazeChem formula: ${formula}`);
  }
  content.notes = notes.join('\n\n');
  return content;
}

// --- CSV ----------------------------------------------------------------------------------------

/** Rows of fields (RFC 4180), with the delimiter the header uses: comma, semicolon or tab. */
export function parseCsv(text: string): string[][] {
  const header = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].reduce((best, d) => (header.split(d).length > header.split(best).length ? d : best));
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) rows.push([...row, field]);
  // A spreadsheet export's guard against formulas ('=...) comes off.
  return rows
    .map((r) => r.map((f) => f.replace(/^'(?=[=+\-@])/, '').trim()))
    .filter((r) => r.some((f) => f));
}

function readCsv(text: string): ImportPlan {
  const rows = parseCsv(text);
  if (!rows.length) throw new ImportError('This file is empty.');
  // "SiO2_percent" (Glazy) and "SiO2 %" are SiO2.
  const header = rows[0].map((h) => h.toLowerCase().replace(/^(.+?)[\s_]*(percent|%)$/, '$1').trim());
  const column = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const body = rows.slice(1);
  const at = (row: string[], index: number) => (index >= 0 ? (row[index] ?? '').trim() : '');

  // Glaze Vault's recipe export: a row per line, the recipe's notes on its first.
  const recipeColumn = column('recipe');
  if (recipeColumn >= 0 && column('material') >= 0 && column('amount') >= 0) {
    const [material, amount, notes, added] = [column('material'), column('amount'), column('notes'), column('added')];
    const detail = (row: string[]) =>
      readDetails({
        type: at(row, column('type')),
        cone: at(row, column('cone')),
        atmosphere: at(row, column('atmosphere')),
        surface: at(row, column('surface')),
        transparency: at(row, column('transparency')),
        color: at(row, column('color', 'colour')),
        tags: at(row, column('tags')),
        gravity: at(row, column('gravity', 'specific gravity', 'sg')),
        viscosity: at(row, column('viscosity'))
      });
    const recipes: RecipeContent[] = [];
    let last: string | null = null;
    for (const row of body) {
      const name = at(row, recipeColumn);
      if (name !== last || !recipes.length) recipes.push({ name, ...detail(row), lines: [], notes: at(row, notes) });
      last = name;
      if (at(row, material) || at(row, amount)) {
        recipes[recipes.length - 1].lines.push({
          material: at(row, material),
          amount: at(row, amount),
          ...(['yes', 'y', 'true', '1', 'x'].includes(at(row, added).toLowerCase()) ? { addition: true } : {})
        });
      }
    }
    return { format: 'Glaze Vault recipes (CSV)', recipes: recipes.map(withLine), materials: [], warnings: [] };
  }

  const kind = column('kind', 'type', 'category');
  const notes = column('notes', 'note', 'description', 'descrip', 'comments');
  // Glaze Vault's material export: a row per oxide.
  const oxideColumn = column('oxide');
  if (oxideColumn >= 0 && column('material') >= 0) {
    const [name, percentColumn, moles] = [column('material'), column('percent'), column('moles')];
    const materials: MaterialContent[] = [];
    let last: string | null = null;
    for (const row of body) {
      const material = at(row, name);
      if (material !== last || !materials.length) {
        materials.push({ name: material, category: categoryOf(at(row, kind)), oxides: [], loi: '', notes: at(row, notes) });
      }
      last = material;
      const current = materials[materials.length - 1];
      const oxide = at(row, oxideColumn);
      if (!oxide) continue;
      if (at(row, moles)) {
        current.basis = 'formula';
        current.formula = [...(current.formula ?? []), { oxide, moles: at(row, moles) }];
      } else if (oxide.toUpperCase() === 'LOI') current.loi = at(row, percentColumn);
      else current.oxides.push({ oxide, percent: at(row, percentColumn) });
    }
    return { format: 'Glaze Vault materials (CSV)', recipes: [], materials, warnings: [] };
  }

  // A data sheet typed up: a name column, then a column per oxide.
  const oxideColumns = header
    .map((h, index) => ({ oxide: oxideNamed(h), index }))
    .filter((c): c is { oxide: string; index: number } => !!c.oxide && OXIDES.includes(c.oxide));
  if (!oxideColumns.length) {
    throw new ImportError(
      'This CSV has no columns Glaze Vault knows. A materials CSV needs a column of names and a column for each oxide, headed SiO2, Al2O3 and so on, with LOI if there is one.'
    );
  }
  const loi = column('loi', 'loss on ignition', 'l.o.i.');
  const named = column('material', 'name', 'material name', 'materials');
  const nameColumn = named >= 0 ? named : header.findIndex((_, i) => !oxideColumns.some((c) => c.index === i) && i !== loi);
  const warnings: string[] = [];
  const unread = rows[0].filter((h, i) => h && ![nameColumn, kind, notes, loi, ...oxideColumns.map((c) => c.index)].includes(i));
  if (unread.length) warnings.push(`These columns were not read: ${unread.join(', ')}.`);
  const materials = body
    .filter((row) => at(row, nameColumn))
    .map(
      (row): MaterialContent => ({
        name: at(row, nameColumn),
        category: categoryOf(at(row, kind)),
        oxides: oxideColumns
          .map(({ oxide, index }) => ({ oxide, percent: tidy(at(row, index)) }))
          .filter((line) => line.percent && amountOf(line.percent) !== 0),
        loi: tidy(at(row, loi)),
        notes: at(row, notes)
      })
    );
  return { format: 'Materials (CSV)', recipes: [], materials, warnings };
}

// --- Shared -------------------------------------------------------------------------------------

/** An oxide's symbol as the chemistry writes it, matched ignoring case: "sio2" → "SiO2". */
function oxideNamed(text: string): string | undefined {
  const wanted = text.trim().toLowerCase();
  return FORMULA_PARTS.find((part) => part.toLowerCase() === wanted);
}

/** A kind from another program's word for it. */
function categoryOf(text: string): MaterialCategory {
  const word = text.trim().toLowerCase();
  const known = MATERIAL_CATEGORIES.find((c) => c.category === word || c.label.toLowerCase() === word);
  if (known) return known.category;
  if (/frit/.test(word)) return 'frit';
  if (/colou?rant|stain|oxide|carbonate/.test(word)) return 'colorant';
  if (/opacif|suspend|additive|gum|binder/.test(word)) return 'additive';
  return 'material';
}

/** 8.600 → 8.6, as typed elsewhere; text that is not a number stays as it is. */
function tidy(text: string): string {
  const trimmed = text.trim();
  const number = Number(trimmed);
  return trimmed && Number.isFinite(number) ? String(number) : trimmed;
}

/** A recipe's details from text as files give them; what matches no option is left out. */
function readDetails(text: { [Field in keyof RecipeDetails]?: string }): RecipeDetails {
  return details({
    type: optionNamed(RECIPE_TYPES, text.type ?? ''),
    cone: (text.cone ?? '').replace(/\s*-\s*/g, '-'),
    atmosphere: optionNamed(ATMOSPHERES, text.atmosphere ?? ''),
    surface: optionNamed(SURFACES, text.surface ?? ''),
    transparency: optionNamed(TRANSPARENCIES, text.transparency ?? ''),
    color: text.color,
    tags: parseTags(text.tags ?? ''),
    gravity: tidy(text.gravity ?? ''),
    viscosity: tidy(text.viscosity ?? '')
  });
}

/** An editor always has a line to type in. */
function withLine(recipe: RecipeContent): RecipeContent {
  return recipe.lines.length ? recipe : { ...recipe, lines: [{ material: '', amount: '' }] };
}

/** Two materials of one name in a file would clash once imported: the first is kept. */
function dedupeMaterials(plan: ImportPlan): ImportPlan {
  const seen = new Set<string>();
  const materials = plan.materials.filter((material) => {
    const key = normalize(material.name);
    if (!key) {
      plan.warnings.push('A material with no name was left out.');
      return false;
    }
    if (seen.has(key)) {
      plan.warnings.push(`${material.name} is in the file twice: the first was kept.`);
      return false;
    }
    seen.add(key);
    return true;
  });
  return { ...plan, materials };
}
