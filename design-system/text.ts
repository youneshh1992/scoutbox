// ScoutBox design system — small text helpers shared by the portal shells.

/** Two-letter initials for an avatar tile: "Maria Keane" → "MK", "Eastport FC" → "EF". */
export function initials(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '·';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}
