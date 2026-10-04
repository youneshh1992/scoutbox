// M24F.5 — server criteria and summaries sometimes carry machine tokens
// (semi_pro, developing_evidence, combine-box-touch-60). People read words:
// "semi-pro", "developing evidence", "Box Touch 60". Meaning is unchanged —
// only the spelling of the token.
const SPECIAL: Record<string, string> = { semi_pro: 'semi-pro', non_league: 'non-league' };

export function humanText(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(/\bcombine-([a-z0-9]+(?:-[a-z0-9]+)*)\b/g, (_m, slug: string) =>
      slug.split('-').map((w) => (/^\d+$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' '))
    .replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (tok) => SPECIAL[tok] ?? tok.replace(/_/g, ' '));
}
