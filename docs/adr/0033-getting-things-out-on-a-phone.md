# 33. Getting things out on a phone: PDFs for printing, CSV through the file picker

Proposed, 2026-11-02. Stage 7 of [the phase 3 plan](../plans/phase-3-mobile.md#7-staged-delivery)
(its section 2.5), on [ADR 31](0031-phone-screens.md), which left printing off phones until now,
and [ADR 28](0028-a-phones-own-vault.md), which moved the recovery sheet as a PDF here.

## Context

A computer prints with `window.print()`: the print dialog takes the `.print-only` paper the page
keeps for each printout (recipe, batch sheet, mix record, blend weights and labels, recovery
sheet). A phone's webview has no print dialog; the call does nothing. Exports (CSV, JSON, XML)
go through the core's save dialog, which on Android answers with a `content://` address, not a
path, so writing one failed. The plan offered two ways to print (a PDF made on the Rust side, or
the native print controller given the webview) and the system share sheet for CSV, to be chosen
after trying them. No phone or emulator here could try them.

## Decision

- **A phone prints by saving a PDF.** The page writes the same `.print-only` paper a computer
  prints as a PDF (`ui/pdf.ts`, no dependencies): headings, paragraphs, lists, tables with their
  headings repeated on each page, and sign-off lines, in Helvetica, which every PDF reader has.
  Charts are left out. Letter in the Americas that use it, A4 elsewhere. The file is named by the
  paper's first heading and saved where the person picks (`save_pdf`). From the Files app or Drive
  it prints, mails or shares like any PDF. One way on both platforms, testable on a computer, and
  no layout to keep twice.
- **Exports go through the file picker**, as on a computer; on Android the picked address is
  written through `tauri-plugin-fs`, as backups were in ADR 28 (`save_picked` in the app).
- **The recovery sheet** says "Save recovery sheet as PDF…" on a phone, and where it went.
- Print buttons show on phones wherever the person's role may print.

## Consequences

- No native code, and none of the native print controllers or share sheets: a person saves,
  then prints or sends from another app. A share sheet can come later with a plugin someone has
  tried on a device.
- The PDF has only WinAnsi's characters: subscript digits are written as digits, check boxes as
  `[ ]`, and anything else unknown as `?`.
- The PDF is plainer than the printed page (no chart, no analysis colors).
- A recovery sheet saved as a PDF is a file of the recovery words on the phone or wherever it was
  saved. The sheet says to print it and keep it safe; deleting the file afterwards is the person's.
- Not yet tried on a phone: the picker's save on iOS and Android with a PDF.
