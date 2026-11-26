import { useEffect, useRef, useState } from 'react';
import { api, errorCode, onEvent, type PhotoSigned, type VaultChanged } from '../api';
import type { Photo } from '../firing';
import { photoSignedBy } from './RevisionHistory';

export function FiringPhotos({
  photos,
  team,
  phone,
  busy,
  onChange,
  onAddPhoto
}: {
  photos: Photo[];
  team: boolean;
  phone: boolean;
  busy: boolean;
  onChange: (photos: Photo[]) => void;
  onAddPhoto: (choose?: () => Promise<Uint8Array>) => void;
}) {
  const urls = usePhotoUrls(photos);
  const signatures = usePhotoSignatures(photos, team);

  return (
    <>
      <h2 className="section-heading">Photos</h2>
      {photos.length > 0 && (
        <div className="photos">
          {photos.map((photo, i) => (
            <figure key={photo.id}>
              {urls[photo.id] ? (
                <img src={urls[photo.id]} alt={photo.caption || `Photo ${i + 1}`} />
              ) : (
                <div className="photo-loading">{urls[photo.id] === '' ? 'Photo not synced yet' : 'Opening…'}</div>
              )}
              <figcaption>
                <input
                  aria-label={`Caption for photo ${i + 1}`}
                  placeholder="What it shows"
                  value={photo.caption}
                  onChange={(e) =>
                    onChange(photos.map((p) => (p.id === photo.id ? { ...p, caption: e.target.value } : p)))
                  }
                />
                <button
                  type="button"
                  className="link danger"
                  aria-label={`Remove photo ${i + 1}`}
                  onClick={() => onChange(photos.filter((p) => p.id !== photo.id))}
                >
                  Remove
                </button>
              </figcaption>
              {signatures[photo.id]?.text && (
                <p className={signatures[photo.id].bad ? 'warn' : 'hint'}>{signatures[photo.id].text}</p>
              )}
            </figure>
          ))}
        </div>
      )}
      {phone ? (
        <div className="photo-inputs">
          <PhotoInput camera disabled={busy} onFile={(file) => onAddPhoto(() => bytesOf(file))}>
            {busy ? 'Adding the photo…' : 'Take photo'}
          </PhotoInput>
          <PhotoInput disabled={busy} onFile={(file) => onAddPhoto(() => bytesOf(file))}>
            Choose photo…
          </PhotoInput>
        </div>
      ) : (
        <button type="button" disabled={busy} onClick={() => onAddPhoto()}>
          {busy ? 'Adding the photo…' : 'Add photo…'}
        </button>
      )}
    </>
  );
}

async function bytesOf(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/** A button that opens the camera (`camera`) or the phone's photos. iOS hands over a JPEG even
 * for a photo kept as HEIC, as the input takes only JPEG and PNG. */
function PhotoInput({
  camera = false,
  disabled,
  onFile,
  children
}: {
  camera?: boolean;
  disabled: boolean;
  onFile: (file: File) => void;
  children: React.ReactNode;
}) {
  return (
    <label className={`button${disabled ? ' disabled' : ''}`}>
      {children}
      <input
        type="file"
        className="visually-hidden"
        accept="image/jpeg,image/png"
        capture={camera ? 'environment' : undefined}
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared, so the same photo can be chosen again after an error.
          e.target.value = '';
          if (file) onFile(file);
        }}
      />
    </label>
  );
}

/** Pictures for the photos, opened from the vault as they are needed and let go when done. A
 * photo whose bytes have not come from the host yet has an empty picture, is asked for, and is
 * tried again when a sync brings photos. */
function usePhotoUrls(photos: Photo[]): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [fetched, setFetched] = useState(0);
  useEffect(
    () =>
      onEvent<VaultChanged>('vault-changed', (changed) => {
        if (changed.fetched) setFetched((n) => n + 1);
      }),
    []
  );
  // Each photo's picture once opened; a photo being opened has none yet.
  const made = useRef<Record<string, string | null>>({});
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const url of Object.values(made.current)) if (url) URL.revokeObjectURL(url);
      made.current = {};
    };
  }, []);
  useEffect(() => {
    for (const photo of photos) {
      if (photo.id in made.current) continue;
      made.current[photo.id] = null;
      api
        .attachment(photo.id)
        .then((buffer) => {
          if (!mounted.current) return;
          const url = URL.createObjectURL(new Blob([buffer], { type: photo.mediaType }));
          made.current[photo.id] = url;
          setUrls((now) => ({ ...now, [photo.id]: url }));
        })
        .catch((e) => {
          delete made.current[photo.id];
          if (mounted.current && errorCode(e) === 'not-fetched') {
            setUrls((now) => ({ ...now, [photo.id]: '' }));
            // Someone is looking at it: it comes first, or at all with photos on demand.
            api.wantPhoto(photo.id).catch(() => {});
          }
        });
    }
  }, [photos.map((p) => p.id).join(), fetched]);
  return urls;
}

/** What each photo's signature says, once asked (docs/adr/0019-signatures-and-audit-log.md), with
 * the names the lock screen's list of people gives. A photo whose signature cannot be read says
 * nothing. */
function usePhotoSignatures(photos: Photo[], team: boolean): Record<string, { text: string; bad: boolean }> {
  const [signed, setSigned] = useState<Record<string, PhotoSigned | null>>({});
  // None until the list of people has come, so nobody is said to be gone from the vault meanwhile.
  const [names, setNames] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    if (!team) return;
    api
      .status()
      .then((status) => setNames(Object.fromEntries(status.people.map((p) => [p.id, p.name]))))
      .catch(() => setNames({}));
  }, [team]);
  const ids = photos.map((p) => p.id).join();
  useEffect(() => {
    let live = true;
    for (const photo of photos) {
      if (photo.id in signed) continue;
      api
        .attachmentSigned(photo.id)
        .then((found) => live && setSigned((now) => ({ ...now, [photo.id]: found })))
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [ids]);
  return Object.fromEntries(photos.map((p) => [p.id, photoSignedBy(signed[p.id] ?? null, names, team)]));
}
