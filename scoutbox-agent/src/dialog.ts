// A drawer behaves as a modal dialog for keyboard users.
// Focus moves into it when it opens, Escape closes it, and focus returns to
// whatever opened it when it closes, so a keyboard user never has to tab
// through the page behind the veil to reach "Close".
import { useEffect, useRef } from 'react';

export function useDialog<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); } };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);
  return ref;
}
