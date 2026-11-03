// Photos for the firing log (docs/adr/0014-firing-log-and-photos.md). A photo straight from a
// camera is several megabytes and far larger than a screen, so the page makes it smaller before
// the core encrypts and keeps it: at most LONGEST_SIDE pixels across, as JPEG, and without what a
// camera writes beside the picture (where it was taken, the phone's make), which drawing it again
// leaves behind. The webview turns the picture upright as it draws it, so nothing is lost by that.

/** The longest side a kept photo has, in pixels: enough to see crazing on a tile. */
export const LONGEST_SIDE = 2560;
const QUALITY = 0.85;

export class PhotoError extends Error {}

/** What kind of image the bytes are, from how they start; null if not one the app takes. */
export function imageType(bytes: Uint8Array): string | null {
  const starts = (...values: number[]) => values.every((value, i) => bytes[i] === value);
  const text = (from: number, length: number) => String.fromCharCode(...bytes.slice(from, from + length));
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (text(0, 4) === 'GIF8') return 'image/gif';
  if (text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') return 'image/webp';
  if (text(4, 4) === 'ftyp' && ['heic', 'heix', 'mif1', 'msf1', 'heif'].includes(text(8, 4))) return 'image/heic';
  return null;
}

/** A photo ready to keep: the bytes as they were if already small enough, or smaller. */
export async function smallerPhoto(bytes: Uint8Array): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const type = imageType(bytes);
  if (!type) throw new PhotoError('That file is not a photo Glaze Vault can read: choose a JPEG, PNG, HEIC or WebP.');
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  try {
    const image = await loaded(url);
    const scale = Math.min(1, LONGEST_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
    if (scale === 1 && type === 'image/jpeg' && !hasMetadata(bytes)) return { bytes, mediaType: type };
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new PhotoError('This photo could not be made smaller.');
    // JPEG has no transparency: a white ground, like paper.
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
    if (!blob) throw new PhotoError('This photo could not be made smaller.');
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mediaType: 'image/jpeg' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Whether a JPEG carries more than its picture: EXIF (with any location), XMP, a comment, or
 * anything else in an APP1 to APP15 or COM segment. APP0 (JFIF) only says how to read it. */
export function hasMetadata(bytes: Uint8Array): boolean {
  let at = 2;
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1];
    // The picture itself starts: no segment past here says anything about the photo.
    if (marker === 0xda) return false;
    if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) return true;
    at += 2 + ((bytes[at + 2] << 8) | bytes[at + 3]);
  }
  // A file that cannot be walked is redrawn, to be safe.
  return at + 4 <= bytes.length;
}

function loaded(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new PhotoError('This photo could not be read. Glaze Vault reads JPEG, PNG and WebP, and HEIC on a Mac.'));
    image.src = url;
  });
}
