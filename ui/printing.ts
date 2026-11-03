// Printing on every platform (docs/adr/0033-getting-things-out-on-a-phone.md): a computer's print
// dialog takes the `.print-only` paper in the page; a phone, whose webview has no print dialog,
// saves the same paper as a PDF where the person chooses, to print or send from there.
import { api, type Platform } from './api';
import { paperPdf } from './pdf';

let platform: Platform = 'desktop';

/** Learned from the vault's status when the app starts. */
export function setPlatform(value: Platform) {
  platform = value;
}

export function printsToPdf(): boolean {
  return platform !== 'desktop';
}

/** Prints the paper now in the page; on a phone, saves it as a PDF named by its first heading.
 * Resolves with the name saved, or null when printed or cancelled. */
export async function printOut(): Promise<string | null> {
  if (!printsToPdf()) {
    window.print();
    return null;
  }
  const papers = [...document.querySelectorAll('.print-only')];
  const heading = papers.map((paper) => paper.querySelector('h1')?.textContent ?? '').find(Boolean) ?? '';
  return api.savePdf(`${safeName(heading)}.pdf`, paperPdf(papers));
}

/** A file name from a title: no slashes or characters file systems refuse. */
export function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Glaze Vault';
}
