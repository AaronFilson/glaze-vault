import { describe, expect, it } from 'vitest';
import { hasMetadata, imageType } from './photos';

/** A JPEG made of segments: each `[marker, length of its data]`, then the picture. */
function jpeg(...segments: [number, number][]): Uint8Array {
  const bytes = [0xff, 0xd8];
  for (const [marker, length] of segments) {
    bytes.push(0xff, marker, (length + 2) >> 8, (length + 2) & 0xff, ...new Array(length).fill(0));
  }
  bytes.push(0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9);
  return new Uint8Array(bytes);
}

describe('a JPEG’s metadata', () => {
  it('finds EXIF, XMP and comments, which can say where a photo was taken', () => {
    expect(hasMetadata(jpeg([0xe0, 14], [0xe1, 300]))).toBe(true);
    expect(hasMetadata(jpeg([0xe0, 14], [0xdb, 67], [0xe2, 10]))).toBe(true);
    expect(hasMetadata(jpeg([0xfe, 5]))).toBe(true);
  });

  it('passes a JPEG with only JFIF and the picture', () => {
    const plain = jpeg([0xe0, 14], [0xdb, 67], [0xc0, 17], [0xc4, 30]);
    expect(imageType(plain)).toBe('image/jpeg');
    expect(hasMetadata(plain)).toBe(false);
  });

  it('counts a JPEG it cannot walk as having some', () => {
    const odd = jpeg([0xe0, 14]);
    odd[20] = 0x00;
    expect(hasMetadata(odd)).toBe(true);
  });
});
