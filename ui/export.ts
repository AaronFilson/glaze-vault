// Exports: every recipe and the person's own materials as CSV (for spreadsheets) or JSON (for
// other programs), and the recipes as Insight XML (for Insight-live and Glazy). None is
// encrypted; the Settings screen says so before saving.
import type { MaterialHead, RecipeHead } from './api';
import { usableLines } from './batch';
import { MATERIAL_CATEGORIES } from './chemistry';

export const EXPORT_FORMAT = 'glaze-vault-export';

export function exportJson(
  recipes: RecipeHead[],
  materials: MaterialHead[],
  exportedAt: Date,
  appVersion: string
): string {
  return (
    JSON.stringify(
      {
        format: EXPORT_FORMAT,
        version: 1,
        exportedAt: exportedAt.toISOString(),
        appVersion,
        recipes: recipes.map((recipe) => ({
          name: recipe.content.name,
          lines: recipe.content.lines.filter((line) => line.material.trim() || line.amount.trim()),
          notes: recipe.content.notes,
          revision: recipe.number,
          savedAt: new Date(recipe.savedAt).toISOString()
        })),
        materials: materials.map((material) => ({
          name: material.content.name,
          category: material.content.category,
          ...(material.content.basis === 'formula' ? { basis: 'formula' } : {}),
          oxides: material.content.oxides.filter((line) => line.percent.trim()),
          loi: material.content.loi,
          ...(material.content.formula?.length
            ? { formula: material.content.formula.filter((line) => line.moles.trim()) }
            : {}),
          notes: material.content.notes,
          revision: material.number,
          savedAt: new Date(material.savedAt).toISOString()
        }))
      },
      null,
      2
    ) + '\n'
  );
}

const CSV_COLUMNS = ['Recipe', 'Material', 'Amount', 'Percent', 'Notes', 'Revision', 'Saved'];

/** One row per material. A recipe's notes, revision and date are on its first row. Starts with a
 * byte order mark so Excel reads it as UTF-8. */
export function exportCsv(recipes: RecipeHead[]): string {
  const rows = [CSV_COLUMNS];
  for (const recipe of recipes) {
    const lines = usableLines(recipe.content.lines);
    const sum = lines.reduce((total, line) => total + line.amount, 0);
    const first = [recipe.content.notes, String(recipe.number), new Date(recipe.savedAt).toISOString()];
    if (!lines.length) rows.push([recipe.content.name, '', '', '', ...first]);
    lines.forEach((line, i) =>
      rows.push([
        recipe.content.name,
        line.material,
        String(line.amount),
        ((line.amount / sum) * 100).toFixed(2),
        ...(i === 0 ? first : ['', '', ''])
      ])
    );
  }
  return '\uFEFF' + rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}

const MATERIAL_COLUMNS = ['Material', 'Kind', 'Oxide', 'Percent', 'Moles', 'Notes', 'Revision', 'Saved'];

/** One row per oxide, with the loss on ignition as the last, like a supplier's data sheet; a
 * material given as a formula has moles instead. A material's kind, notes, revision and date are
 * on its first row. */
export function exportMaterialsCsv(materials: MaterialHead[]): string {
  const rows = [MATERIAL_COLUMNS];
  const label = (category: string) => MATERIAL_CATEGORIES.find((c) => c.category === category)?.label ?? category;
  for (const material of [...materials].sort((a, b) => a.content.name.localeCompare(b.content.name))) {
    const { name, category, basis, oxides, loi, formula, notes } = material.content;
    const lines =
      basis === 'formula'
        ? (formula ?? []).filter((line) => line.moles.trim()).map((line) => [line.oxide, '', line.moles.trim()])
        : [
            ...oxides.filter((line) => line.percent.trim()).map((line) => [line.oxide, line.percent.trim(), '']),
            ...(loi.trim() ? [['LOI', loi.trim(), '']] : [])
          ];
    const first = [notes, String(material.number), new Date(material.savedAt).toISOString()];
    if (!lines.length) rows.push([name, label(category), '', '', '', ...first]);
    lines.forEach(([oxide, percent, moles], i) =>
      rows.push([name, i === 0 ? label(category) : '', oxide, percent, moles, ...(i === 0 ? first : ['', '', ''])])
    );
  }
  return '\uFEFF' + rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}

/** Recipes as Insight XML, which Digitalfire's Insight-live and Glazy import (docs/adr/0010-importing.md).
 * Amounts are parts, written as grams; each recipe is dated the day its revision was saved. */
export function exportInsightXml(recipes: RecipeHead[]): string {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<recipes version="1.0" encoding="UTF-8">'];
  for (const recipe of recipes) {
    const { name, notes } = recipe.content;
    out.push(`<recipe name="${xmlText(name)}" keywords="" id="" date="${localDate(new Date(recipe.savedAt))}" codenum="">`);
    out.push('<recipelines>');
    for (const line of usableLines(recipe.content.lines)) {
      out.push(
        `<recipeline material="${xmlText(line.material)}" amount="${line.amount}" unitabbr="g" conversion="1.0000" added="0"/>`
      );
    }
    out.push('</recipelines>');
    if (notes.trim()) out.push(`<notes>${xmlText(notes.trim(), false)}</notes>`);
    out.push('</recipe>');
  }
  out.push('</recipes>');
  return out.join('\n') + '\n';
}

/** Text for XML: escaped, without the control characters XML 1.0 cannot hold. In an attribute,
 * line breaks are kept as character references, which readers would otherwise turn into spaces. */
function xmlText(text: string, attribute = true): string {
  const escaped = text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return attribute
    ? escaped.replaceAll('"', '&quot;').replaceAll('\r', '&#13;').replaceAll('\n', '&#10;').replaceAll('\t', '&#9;')
    : escaped;
}

/** Quotes a field when it needs it (RFC 4180). Text that a spreadsheet would run as a formula gets
 * a leading apostrophe, so opening an export cannot run anything. */
export function csvField(value: string): string {
  let text = value;
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

/** "Glaze Vault recipes 2026-10-14.csv", in local time. */
export function exportFileName(extension: 'csv' | 'json' | 'xml', now: Date, what = 'recipes'): string {
  return `Glaze Vault ${what} ${localDate(now)}.${extension}`;
}

export function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
