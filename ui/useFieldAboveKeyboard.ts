import { useEffect } from 'react';

/** How long the phone's keyboard takes to come up, after which the page has its new height. */
const KEYBOARD_MS = 300;

/** On a phone, moves the field being typed into to the middle of what the keyboard leaves showing,
 * once the keyboard is up (docs/adr/0031-phone-screens.md). Off on computers. */
export function useFieldAboveKeyboard(on: boolean) {
  useEffect(() => {
    if (!on) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const focused = (event: FocusEvent) => {
      const field = event.target;
      if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement))
        return;
      clearTimeout(timer);
      timer = setTimeout(() => field.scrollIntoView?.({ block: 'center' }), KEYBOARD_MS);
    };
    document.addEventListener('focusin', focused);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('focusin', focused);
    };
  }, [on]);
}
