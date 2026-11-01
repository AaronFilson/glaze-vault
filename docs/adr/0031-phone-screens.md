# 31. Phone screens: the bottom bar, one column, and what a phone offers

Proposed, 2026-10-31. Stage 5 of [the phase 3 plan](../plans/phase-3-mobile.md#7-staged-delivery)
(its sections 2.4 and 5), on [ADR 27](0027-phones.md)'s platform in the vault's status,
[ADR 28](0028-a-phones-own-vault.md)'s own vault and [ADR 29](0029-phones-as-replicas.md)'s
replicas.

## Context

The open vault was laid out for a window: a bar of buttons across the top, three columns, tables
as wide as their columns, and controls sized for a mouse. Under 900 px it already fell to one
column. A phone is 375 to 430 px wide, is used with a thumb, has a keyboard that covers half the
screen, and has system bars at its edges. A phone that joined a host should not offer running the
vault, which is a computer's job there.

## Decision

- **Width decides the layout, the platform decides what is offered.** A narrow computer window
  gets the single column and scrolling tables too; only a phone gets the bottom bar and loses
  screens.
- **The bottom bar** (`phone-nav` in `Recipes.tsx`), on phones under 768 px: Recipes, Mix log,
  Firing log and More. More opens a menu of Materials, Batch sheets (in a team), Settings and
  Lock. The top bar keeps the name and the sync status there; its view buttons and Lock are
  hidden. From 768 px, a tablet keeps the computer's bar and no bottom bar. The bars clear the
  system's edges with `env(safe-area-inset-*)`, which needs `viewport-fit=cover` in `index.html`.
- **What a phone offers** (`offered` in `ui/phone.ts`): a phone's own vault offers everything but
  hosting (ADR 28). A phone that joined a host leaves import, backups, set-aside vaults, people,
  roles, sharing and the audit log to a computer, and Settings says so. Roles still decide what a
  person may do; this only decides what the phone shows. The page learns whether the vault is a
  replica from `network_status`, which it already had.
- **Printing is not offered on a phone** until stage 7 of the plan, since `window.print()` does
  nothing in a phone's webview.
- **Under 600 px**, the tables of lines, analyses, comparisons and facts scroll sideways inside
  themselves, with the first column kept in view; the vitrification chart scrolls inside its frame
  at a readable width rather than shrinking. The page itself never scrolls sideways.
- **Touch** (`pointer: coarse`, whatever the width): buttons, selects and fields at least 44 px
  high, and larger checkboxes. Nothing was shown on hover only, so nothing else changed.
- **The keyboard**: number fields already used `inputmode="decimal"`. On a phone, the field
  being typed into is scrolled to the middle of what the keyboard leaves, once the keyboard is up
  (`useFieldAboveKeyboard`).

## Consequences

- Computers at their usual widths look and behave as before: the bottom bar is never rendered on
  them, and the new rules are for narrow widths and touch screens.
- A narrow computer window now scrolls wide tables inside themselves.
- Nothing here has been seen on a phone. The More menu, the safe-area insets and the keyboard
  scroll want a check on a device.
- The shop-floor screens use their existing layouts in one column. A layout made for each of them
  on a phone (a batch sheet as cards, say) can come when someone has used them on the floor.
