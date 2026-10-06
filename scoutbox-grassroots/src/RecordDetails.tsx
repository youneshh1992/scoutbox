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
