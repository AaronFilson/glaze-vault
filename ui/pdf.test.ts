// @vitest-environment jsdom
import { mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';
import { paperPdf, paperSize, textWidth, wrap } from './pdf';
import { printOut, safeName, setPlatform } from './printing';

function paper(html: string): HTMLElement {
  const section = document.createElement('section');
  section.className = 'print-only paper';
  section.innerHTML = html;
  document.body.append(section);
  return section;
}

const text = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes);

afterEach(() => {
  document.body.innerHTML = '';
  setPlatform('desktop');
});

describe('a paper as a PDF', () => {
  it('writes the headings, text and table cells, with offsets a reader can follow', () => {
    const pdf = text(
      paperPdf([
        paper(`<p class="confidential">Confidential · Printed today</p>
          <h1>Mix record: Céladon (cone 6)</h1>
          <table class="paper-table"><thead><tr><th>Material</th><th class="num">Weight (g)</th><th>Lot</th></tr></thead>
          <tbody><tr><td>SiO₂ silica</td><td class="num">250</td><td class="write-in"></td></tr></tbody></table>
          <dl class="signoff"><dt>Weighed by</dt><dd></dd></dl>
          <svg><text>chart</text></svg>`)
      ])
    );
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain('(Mix record: C\\351ladon \\(cone 6\\)) Tj');
    expect(pdf).toContain('(Confidential \\267 Printed today) Tj');
    expect(pdf).toContain('(SiO2 silica) Tj');
    expect(pdf).toContain('(250) Tj');
    expect(pdf).toContain('(Weighed by: ______________________________) Tj');
    expect(pdf).not.toContain('chart');
    // Each object where the cross-reference table says it is.
    const xref = Number(pdf.match(/startxref\n(\d+)/)![1]);
    expect(pdf.slice(xref, xref + 4)).toBe('xref');
    const offsets = [...pdf.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((at, i) => expect(pdf.slice(at).startsWith(`${i + 1} 0 obj`)).toBe(true));
    for (const match of pdf.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
      const start = match.index! + match[0].length;
      expect(pdf.slice(start + Number(match[1]), start + Number(match[1]) + 10)).toBe('\nendstream');
    }
  });

  it('goes on to more pages, a long table taking its headings along', () => {
    const rows = Array.from({ length: 120 }, (_, i) => `<tr><td>Material ${i}</td><td class="num">${i}</td></tr>`).join('');
    const pdf = text(paperPdf([paper(`<h1>Long</h1><table><thead><tr><th>Material</th><th>g</th></tr></thead><tbody>${rows}</tbody></table>`)]));
    const pages = Number(pdf.match(/\/Count (\d+)/)![1]);
    expect(pages).toBeGreaterThan(1);
    expect(pdf.match(/\(Material\) Tj/g)!.length).toBe(pages);
  });

  it('starts each paper on a page of its own', () => {
    const pdf = text(paperPdf([paper('<h1>One</h1>'), paper('<h1>Two</h1>')]));
    expect(pdf).toContain('/Count 2');
  });

  it('wraps text to the width, breaking a word too long for a line', () => {
    expect(wrap('a b c', 10, 'regular', 1000)).toEqual(['a b c']);
    const lines = wrap('x'.repeat(100), 10, 'regular', 100);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(textWidth(line, 10)).toBeLessThanOrEqual(100);
  });

  it('is Letter in the United States and A4 elsewhere', () => {
    expect(paperSize('en-US')).toEqual([612, 792]);
    expect(paperSize('en-GB')).toEqual([595, 842]);
  });
});

describe('printing', () => {
  it('on a phone, saves the paper as a PDF named by its heading', async () => {
    let sent: Uint8Array | null = null;
    mockIPC((cmd, args) => {
      if (cmd === 'save_pdf') {
        sent = args as Uint8Array;
        return 'Batch sheet Clear.pdf';
      }
      return null;
    });
    paper('<h1>Batch sheet: Clear</h1>');
    setPlatform('android');
    expect(await printOut()).toBe('Batch sheet Clear.pdf');
    expect(text(sent!).startsWith('%PDF-')).toBe(true);
    expect(text(sent!)).toContain('(Batch sheet: Clear) Tj');
  });

  it('names files without characters a file system refuses', () => {
    expect(safeName('Batch sheet: 1/2 "test"')).toBe('Batch sheet 1 2 test');
    expect(safeName('  ')).toBe('Glaze Vault');
  });
});
