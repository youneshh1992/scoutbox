// M24F.3 — progressive disclosure for the portals. A screen's root shows one
// line; anything longer than a line sits behind an "About" control. `Hint`
// decides by length, so a short server-provided note still reads inline and a
// long one folds away without the screen having to know which it will get.
import type { CSSProperties, ReactNode } from 'react';

/** Visible-text length beyond which a hint is an explanation, not a line. */
export const LONG_HINT = 140;

const aboutLabel = () => (typeof document !== 'undefined' && document.documentElement.lang === 'fr' ? 'À propos' : 'About');

export function About({ label, children, open, testID }: { label?: string; children: ReactNode; open?: boolean; testID?: string }) {
  return (
    <details className="f-about" open={open} data-testid={testID}>
      <summary>{label ?? aboutLabel()}</summary>
      {children}
    </details>
  );
}

function textOf(node: ReactNode): string | null {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) {
    const parts = node.map(textOf);
    return parts.some((p) => p === null) ? null : parts.join('');
  }
  return null; // an element: its length is unknown here, so it shows as written
}

/**
 * A hint under a heading. Short text renders in place; text longer than a
 * line renders behind "About" (closed). Keeps whatever test id it was given.
 */
export function Hint({ children, className = 'pagehint', style, testID, label }: {
  children: ReactNode; className?: string; style?: CSSProperties; testID?: string; label?: string;
}) {
  const text = textOf(children);
  if (text !== null && text.trim().length === 0) return null;
  const long = text !== null && text.length > LONG_HINT;
  const body = className.split(/\s+/).includes('pagehint')
    ? <p className={className} style={style} data-testid={testID}>{children}</p>
    : <div className={className} style={style} data-testid={testID}>{children}</div>;
  return long ? <About label={label}>{body}</About> : body;
}
