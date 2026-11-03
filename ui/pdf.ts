// What a phone prints (docs/adr/0033-getting-things-out-on-a-phone.md): a phone's webview has no
// print dialog, so the paper a computer would print, the `.print-only` sections, is written as a
// PDF to save, share or print from the phone's own apps. Text and tables only, in Helvetica, which
// every PDF reader has: headings, paragraphs, lists, tables and sign-off lines. Charts are left out.

type Font = 'regular' | 'bold';

/** Helvetica's widths, in thousandths of the size, for characters 32 to 126. */
const REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
  556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584
];
const BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611,
  611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584
];

/** Characters outside Latin-1 that WinAnsi has, by their code there. */
const WIN_ANSI: Record<string, number> = {
  '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96,
  '—': 0x97, '™': 0x99
};
/** Characters WinAnsi lacks, written as near as it can. */
const NEAR: Record<string, string> = { '☐': '[  ]', '☑': '[x]', '≥': '>=', '≤': '<=', '−': '-', '→': '->', ' ': ' ' };
const SUBSCRIPTS = '₀₁₂₃₄₅₆₇₈₉';

/** The text as WinAnsi codes, one a character. */
function codes(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const sub = SUBSCRIPTS.indexOf(ch);
    if (sub >= 0) out.push(48 + sub);
    else if (NEAR[ch]) out.push(...codes(NEAR[ch]));
    else if (WIN_ANSI[ch]) out.push(WIN_ANSI[ch]);
    else {
      const code = ch.codePointAt(0)!;
      out.push((code >= 32 && code < 127) || (code >= 0xa0 && code <= 0xff) ? code : 63);
    }
  }
  return out;
}

export function textWidth(text: string, size: number, font: Font = 'regular'): number {
  const widths = font === 'bold' ? BOLD : REGULAR;
  return (codes(text).reduce((sum, code) => sum + (code >= 32 && code < 127 ? widths[code - 32] : 556), 0) * size) / 1000;
}

/** The text in lines no wider than `width`; a word too long for a line is broken. */
export function wrap(text: string, size: number, font: Font, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const tried = line ? `${line} ${word}` : word;
      if (textWidth(tried, size, font) <= width) {
        line = tried;
        continue;
      }
      if (line) lines.push(line);
      line = word;
      while (textWidth(line, size, font) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && textWidth(line.slice(0, cut), size, font) > width) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Letter in the Americas that use it, A4 elsewhere; in points. */
export function paperSize(locale = typeof navigator === 'undefined' ? 'en-US' : navigator.language): [number, number] {
  return /-(US|CA|MX|PH|CL|CO|VE)$/i.test(locale) ? [612, 792] : [595, 842];
}

const MARGIN = 50;
const SIZE = 10;
const LEADING = 1.3;
const PAD = 3;

class Pages {
  readonly pages: string[][] = [[]];
  y: number;
  constructor(
    readonly width: number,
    readonly height: number
  ) {
    this.y = height - MARGIN;
  }
  get usable() {
    return this.width - 2 * MARGIN;
  }
  /** Room for `height` more, on a new page if this one has not. */
  room(height: number) {
    if (this.y - height < MARGIN && this.y < this.height - MARGIN) {
      this.pages.push([]);
      this.y = this.height - MARGIN;
    }
  }
  private get ops() {
    return this.pages[this.pages.length - 1];
  }
  text(x: number, y: number, text: string, size: number, font: Font, gray = false) {
    const escaped = codes(text)
      .map((code) =>
        code === 40 || code === 41 || code === 92
          ? `\\${String.fromCharCode(code)}`
          : code < 127
            ? String.fromCharCode(code)
            : `\\${code.toString(8).padStart(3, '0')}`
      )
      .join('');
    this.ops.push(
      `BT ${gray ? '0.4 g' : '0 g'} /${font === 'bold' ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${escaped}) Tj ET`
    );
  }
  rule(x1: number, x2: number, y: number) {
    this.ops.push(`0.6 G 0.5 w ${x1.toFixed(2)} ${y.toFixed(2)} m ${x2.toFixed(2)} ${y.toFixed(2)} l S`);
  }
  /** A block of text across the page, wrapped, moving down past it. */
  paragraph(text: string, size = SIZE, font: Font = 'regular', gray = false, before = 4, indent = 0) {
    const lines = wrap(text, size, font, this.usable - indent);
    const leading = size * LEADING;
    this.y -= before;
    for (const line of lines) {
      this.room(leading);
      this.y -= leading;
      this.text(MARGIN + indent, this.y + size * 0.25, line, size, font, gray);
    }
  }
}

interface Cell {
  text: string;
  bold: boolean;
  num: boolean;
}

/** An element's text, its parts kept apart where they are side by side on paper. */
function textOf(element: Element): string {
  const parts = [...element.childNodes];
  const elements = parts.filter((node) => node.nodeType === 1) as Element[];
  const loose = parts.some((node) => node.nodeType === 3 && node.textContent!.trim());
  if (elements.length > 1 && !loose && elements.every((e) => e.tagName === 'SPAN' || e.tagName === 'STRONG')) {
    return elements.map(textOf).filter(Boolean).join('  ·  ');
  }
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function table(pages: Pages, element: HTMLTableElement) {
  const rows: { cells: Cell[]; head: boolean }[] = [...element.rows].map((row) => ({
    head: row.parentElement?.tagName === 'THEAD',
    cells: [...row.cells].map((cell) => ({
      text: textOf(cell),
      bold: cell.tagName === 'TH',
      num: cell.classList.contains('num')
    }))
  }));
  const columns = Math.max(0, ...rows.map((row) => row.cells.length));
  if (!columns) return;
  // Each column as wide as its widest cell, and a column left to write in some room for a pen.
  const natural = Array.from({ length: columns }, (_, i) => {
    const widest = Math.max(
      0,
      ...rows.map((row) => (row.cells[i] ? textWidth(row.cells[i].text, SIZE, row.cells[i].bold ? 'bold' : 'regular') : 0))
    );
    const written = rows.some((row) => !row.head && row.cells[i]?.text);
    return Math.max(widest, written ? 0 : 50) + 2 * PAD;
  });
  const total = natural.reduce((a, b) => a + b, 0);
  const widths = total > pages.usable ? natural.map((w) => (w * pages.usable) / total) : natural;
  const right = MARGIN + widths.reduce((a, b) => a + b, 0);
  const leading = SIZE * LEADING;
  const head = rows.filter((row) => row.head);

  const draw = (row: (typeof rows)[number]) => {
    const wrapped = row.cells.map((cell, i) =>
      wrap(cell.text, SIZE, cell.bold || row.head ? 'bold' : 'regular', Math.max(widths[i] - 2 * PAD, 8))
    );
    const height = Math.max(1, ...wrapped.map((lines) => lines.length)) * leading + 2 * PAD;
    return { wrapped, height };
  };
  const put = (row: (typeof rows)[number], wrapped: string[][], height: number) => {
    let x = MARGIN;
    row.cells.forEach((cell, i) => {
      const font: Font = cell.bold || row.head ? 'bold' : 'regular';
      wrapped[i].forEach((line, n) => {
        const at = cell.num ? x + widths[i] - PAD - textWidth(line, SIZE, font) : x + PAD;
        pages.text(at, pages.y - PAD - (n + 1) * leading + SIZE * 0.25, line, SIZE, font);
      });
      x += widths[i];
    });
    pages.y -= height;
    pages.rule(MARGIN, right, pages.y);
  };

  pages.y -= 6;
  pages.room(2 * leading);
  pages.rule(MARGIN, right, pages.y);
  for (const row of rows) {
    const { wrapped, height } = draw(row);
    const page = pages.pages.length;
    pages.room(height);
    // A table that goes on to another page takes its headings with it.
    if (pages.pages.length !== page && !row.head) {
      pages.rule(MARGIN, right, pages.y);
      for (const h of head) {
        const drawn = draw(h);
        put(h, drawn.wrapped, drawn.height);
      }
    }
    put(row, wrapped, height);
  }
}

function block(pages: Pages, element: Element) {
  if (element.classList.contains('no-print') || element instanceof SVGElement) return;
  switch (element.tagName) {
    case 'H1':
      pages.paragraph(textOf(element), 17, 'bold', false, 10);
      return;
    case 'H2':
    case 'H3':
      pages.paragraph(textOf(element), 12.5, 'bold', false, 10);
      return;
    case 'P': {
      const small = element.classList.contains('confidential') || element.classList.contains('meta');
      pages.paragraph(textOf(element), small ? 9 : SIZE, 'regular', small);
      return;
    }
    case 'TABLE':
      table(pages, element as HTMLTableElement);
      return;
    case 'UL':
    case 'OL':
      pages.y -= 4;
      for (const item of element.children) pages.paragraph(textOf(item), SIZE, 'regular', false, 2, 12);
      return;
    case 'DL': {
      pages.y -= 4;
      const items = [...element.children];
      for (let i = 0; i < items.length; i++) {
        if (items[i].tagName !== 'DT') continue;
        const answer = items[i + 1]?.tagName === 'DD' ? textOf(items[i + 1]) : '';
        pages.paragraph(`${textOf(items[i])}: ${answer || '______________________________'}`, SIZE, 'regular', false, 8);
      }
      return;
    }
    default:
      if (element.children.length) for (const child of element.children) block(pages, child);
      else if (textOf(element)) pages.paragraph(textOf(element));
  }
}

/** The papers, one after another, as a PDF's bytes. */
export function paperPdf(papers: Element[], size: [number, number] = paperSize()): Uint8Array {
  const pages = new Pages(...size);
  papers.forEach((paper, i) => {
    if (i > 0) pages.room(Infinity);
    for (const child of paper.children) block(pages, child);
  });

  // Objects: 1 catalog, 2 page tree, 3 and 4 the fonts, then each page and its contents.
  const objects: string[] = [];
  const kids = pages.pages.map((_, i) => `${5 + 2 * i} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.pages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  pages.pages.forEach((ops, i) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size[0]} ${size[1]}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + 2 * i} 0 R >>`
    );
    const stream = ops.join('\n');
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  // Every byte is ASCII (others are escaped), so a string's length is its length in bytes.
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
