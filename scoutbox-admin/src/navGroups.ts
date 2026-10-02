// M24D — the Trust & Safety console's navigation, as plain data so the
// navigation suite can assert the five rule on it without a browser.
//
// Presentation only. Every tab id stays a live destination; the admin key and
// the server's rules gate every read and write exactly as before. The groups
// arrange the console's twenty-eight pages so that no group lists more than
// five: the player-record reviews (Passport corrections, Box Cam sessions,
// Trust Score) left Cases for Evidence, and the delivery and billing pages
// left Operations for Delivery & Billing.
export const ADMIN_NAV_MAX = 5;

export const ADMIN_NAV_GROUPS = [
  { id: 'home', label: 'Home', tabs: ['overview'] },
  { id: 'cases', label: 'Cases', tabs: ['reports', 'disputes', 'verdisputes', 'supportdesk'] },
  { id: 'evidence', label: 'Evidence', tabs: ['passport', 'boxcam', 'trust'] },
  { id: 'verification', label: 'Verification', tabs: ['verification', 'clubs', 'guardians', 'staffchecks', 'coaches'] },
  { id: 'safety', label: 'Safety', tabs: ['blocks', 'moderation', 'threads', 'drillguide'] },
  { id: 'operations', label: 'Operations', tabs: ['outcomes', 'representation', 'groups'] },
  { id: 'delivery', label: 'Delivery & Billing', tabs: ['deliverycentre', 'outbox', 'billing'] },
  // M23 P5.6C: the attributed compliance lane. Its own credentialed sign-in —
  // the admin key that opens this console is not a reviewer identity (G-C0).
  // M23 P5.6D adds the transaction READ to the same lane: same reviewer gate,
  // states and party roles only, and no action on a transaction at all.
  { id: 'agents', label: 'Agents', tabs: ['agentreview', 'agentpolicy', 'agentreviewers', 'agenttransactions'] },
  { id: 'system', label: 'System', tabs: ['servicehealth', 'backups'] },
] as const;

export type AdminNavGroup = (typeof ADMIN_NAV_GROUPS)[number];
export type AdminNavTab = AdminNavGroup['tabs'][number];

/** Structural problems with the console's navigation; empty means sound. */
export function validateAdminNav(groups: readonly { id: string; label: string; tabs: readonly string[] }[] = ADMIN_NAV_GROUPS): string[] {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  for (const g of groups) {
    if (g.tabs.length === 0) problems.push(`${g.id}: empty group`);
    if (g.tabs.length > ADMIN_NAV_MAX) problems.push(`${g.id}: ${g.tabs.length} pages (max ${ADMIN_NAV_MAX})`);
    for (const t of g.tabs) seen.set(t, (seen.get(t) ?? 0) + 1);
  }
  for (const [t, n] of seen) if (n !== 1) problems.push(`"${t}" appears in ${n} groups (must be exactly 1)`);
  return problems;
}
