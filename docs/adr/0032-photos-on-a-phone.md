# 32. Photos on a phone: the camera, size, and where a photo was taken

Proposed, 2026-11-02. Stage 6 of [the phase 3 plan](../plans/phase-3-mobile.md#7-staged-delivery)
(its sections 3.4 and 4, and question 5), on [ADR 14](0014-firing-log-and-photos.md)'s photos,
[ADR 25](0025-host-backups-from-the-app.md)'s photos on demand and [ADR 31](0031-phone-screens.md)'s
phone screens.

## Context

Test tiles come out of the kiln in the kiln room, and the phone in a pocket there has a camera. A
desktop picks a photo with a native dialog the core reads; on Android a picked file is a
`content://` address, not a path the core can open. iPhones keep photos as HEIC, which Windows
and Linux webviews cannot show. A camera's JPEG carries EXIF, often with the place it was taken,
and the page kept a small enough JPEG exactly as it came, EXIF and all. And a phone that brings
every photo of a team's years of tiles fills up.

## Decision

- **"Take photo" and "Choose photo…" on a phone**, in place of "Add photo…": file inputs in the
  page (`capture="environment"` for the camera), read with `File.arrayBuffer()`. No plugin, and
  no path for the core to open. Computers keep the native dialog.
- **JPEG and PNG only from the inputs.** iOS then hands over a JPEG even for a photo kept as
  HEIC, so no HEIC reaches the vault from a phone. HEIC chosen on a Mac is still read by its
  webview and kept as JPEG, as before.
- **2,560 pixels on the long edge, JPEG quality 85** (question 5's default), on every platform.
- **Nothing beside the picture is kept.** A photo is drawn again, which leaves EXIF, XMP and
  comments behind, unless it is already a JPEG small enough with only its picture and JFIF
  (`hasMetadata` in ui/photos.ts walks its segments). The webview turns the picture upright as it
  draws it, so the orientation is in the pixels. The time it was taken goes too: the firing has
  its own date.
- **Photos on demand is on by default on phones and tablets** (`photos_on_demand` in the core,
  by target), until someone chooses in Settings > Network. Computers keep bringing every photo.

## Consequences

- No photo in a vault says where it was taken, from any platform.
- A small JPEG with EXIF is now re-encoded, losing a little quality; a camera's photo was always
  re-encoded, being larger.
- Someone who measures crazing from photos gets 2,560 pixels, not the original. Keeping originals
  could be a setting later.
- None of this has run on a phone: the camera input on Android's webview and iOS's JPEG hand-over
  want a check on a device (stage 8's emulators can try the first).
