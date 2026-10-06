import type { ReactNode } from 'react';

/** Present the supplied facts separately without parsing, ranking or dropping values. */
export function RecordFacts({ items }: { items: { label: ReactNode; value: ReactNode }[] }) {
  if (!items.length) return null;
  return <dl className="record-facts">{items.map((item, i) => <div key={i}><dt>{item.label}</dt><dd>{item.value ?? '—'}</dd></div>)}</dl>;
}

/** Inline-safe markup also works inside table cells, notices and metadata spans. */
export function DetailItems({ items }: { items: ReactNode[] }) {
  return <span className="record-items" role="list">{items.map((item, i) => <span role="listitem" key={i}>{item}</span>)}</span>;
}

/** Presentation only: preserve proper nouns; separate stored enum words. */
export function sentenceCase(value: string | null | undefined): string {
  const text = (value ?? '').replace(/_/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Not recorded';
}
