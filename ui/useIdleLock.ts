import { useEffect, useRef } from 'react';

const ACTIVITY = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

/** True once `minutes` have passed since the last activity. Uses the wall clock, so time asleep or
 * minimized counts. */
export function isIdle(lastActivity: number, now: number, minutes: number): boolean {
  return now - lastActivity >= minutes * 60_000;
}

/** Calls `onIdle` once when nobody has used the window for `minutes`. Null turns it off. */
export function useIdleLock(minutes: number | null, onIdle: () => void) {
  const callback = useRef(onIdle);
  callback.current = onIdle;

  useEffect(() => {
    if (!minutes) return;
    let last = Date.now();
    let fired = false;
    const check = () => {
      if (!fired && isIdle(last, Date.now(), minutes)) {
        fired = true;
        callback.current();
      }
    };
    // Checks before counting the activity: timers can be paused while the app is in the
    // background, and coming back to it must not count as using it in time.
    const touch = () => {
      check();
      last = Date.now();
    };
    for (const event of ACTIVITY) window.addEventListener(event, touch, { capture: true, passive: true });
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    const timer = window.setInterval(check, 10_000);
    return () => {
      for (const event of ACTIVITY) window.removeEventListener(event, touch, { capture: true });
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
      window.clearInterval(timer);
    };
  }, [minutes]);
}

/** How long a phone's app may be in the background before the vault locks. */
export const BACKGROUND_GRACE_SECONDS = 30;

/** True once `seconds` have passed since the app went to the background at `hiddenAt`. */
export function awayTooLong(hiddenAt: number, now: number, seconds: number): boolean {
  return now - hiddenAt >= seconds * 1000;
}

/** Phones (docs/adr/0027-phones.md): calls `onAway` once when the app has been in the background
 * for `seconds`. A suspended app runs no timers, so coming back also checks the wall clock. Null
 * turns it off. */
export function useBackgroundLock(seconds: number | null, onAway: () => void) {
  const callback = useRef(onAway);
  callback.current = onAway;

  useEffect(() => {
    if (seconds === null) return;
    let hiddenAt: number | null = null;
    let timer: number | undefined;
    let fired = false;
    const fire = () => {
      if (fired) return;
      fired = true;
      callback.current();
    };
    const changed = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt ??= Date.now();
        window.clearTimeout(timer);
        timer = window.setTimeout(fire, seconds * 1000);
        return;
      }
      window.clearTimeout(timer);
      if (hiddenAt !== null && awayTooLong(hiddenAt, Date.now(), seconds)) fire();
      hiddenAt = null;
    };
    document.addEventListener('visibilitychange', changed);
    return () => {
      document.removeEventListener('visibilitychange', changed);
      window.clearTimeout(timer);
    };
  }, [seconds]);
}
