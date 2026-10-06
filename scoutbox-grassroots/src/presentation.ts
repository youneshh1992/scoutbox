/** Presentation only: preserve proper nouns; separate stored enum words. */
export function sentenceCase(value: string | null | undefined): string {
  const text = (value ?? '').replace(/_/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Not recorded';
}
