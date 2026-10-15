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
