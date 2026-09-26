// PRE-M24 (PM-8): a drawer behaves as a modal dialog for keyboard users.
// Focus moves into it when it opens, Escape closes it, and focus returns to
// whatever opened it when it closes. Before this, the Report & block, Compare
// and player drawers had no Escape, no dialog role and left focus behind the
// veil, so a keyboard user had to tab through the page to reach "Close".
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

// PRE-M24 (PM-14): a clickable row, card or link without an href is reachable
// and operable from the keyboard. Before this, player cards, feed rows and the
// player-name links opened the player only on a mouse click: Tab skipped them
// and Enter did nothing. Keys pressed on a control inside the element (the
// compare checkbox on a card) are left to that control.
export function pressable(onActivate: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e: { key: string; target: unknown; currentTarget: unknown; preventDefault: () => void }) => {
      if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      onActivate();
    },
  };
}
