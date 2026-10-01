// M24B — how a suite reaches a page of a recruitment case now that the flat
// tab strips are category → subcategory. A page is addressed by its stable
// sub id; the helper opens the category that holds it (reading `data-subs`
// off the category buttons, so a page that moves category needs no test
// change), then the sub, then waits for its ARIA tabpanel.
//
// Only the current category's pages are in the DOM — a private page is
// absent, not hidden — so a locator by name must come AFTER one of these.

const ROOM_LABELS = {
  Overview: 'summary', Summary: 'summary', Journey: 'journey', Tasks: 'tasks', Activity: 'activity',
  Passport: 'passport', Combine: 'combine', Development: 'development',
  Evidence: 'evidence', Assessments: 'assessments', Decision: 'decision', 'Second Look': 'secondlook',
  Contact: 'contact', Trial: 'trial', Inbox: 'inbox', Discussion: 'discussion',
  Offer: 'offer', Signing: 'signing', Documents: 'documents',
  Timeline: 'timeline', 'Previous decisions': 'past-decisions', 'Previous trials': 'past-trials', 'Previous offers': 'past-offers', 'Previous signings': 'past-signings',
};

export async function openSub(page, subId, { nav = '[data-casenav]', prefix = 'rm', timeout = 15000 } = {}) {
  const root = page.locator(nav).first();
  await root.waitFor({ timeout });
  const cat = root.locator(`.casenav-cat[data-subs~="${subId}"]`);
  if ((await cat.count()) === 0) throw new Error(`caseNav: no category of ${nav} holds "${subId}"`);
  if ((await cat.getAttribute('aria-current')) !== 'true') { await cat.click(); await page.waitForTimeout(150); }
  const sub = root.locator(`.casenav-sub[data-sub="${subId}"]`);
  if ((await sub.getAttribute('aria-selected')) !== 'true') await sub.click();
  await page.waitForSelector(`#${prefix}-panel-${subId}`, { timeout });
}

/** The Recruitment Room (Pro / Grassroots): by the label the suites always used ("Decision", "Offer", …; "Overview" is now Overview › Summary). */
export const roomTab = (page, name) => openSub(page, ROOM_LABELS[name] ?? name, { nav: '[data-casenav="room"]', prefix: 'rm' });
/** The tabpanel label a Room page carries (the old "Overview" page is "Summary"). */
export const roomPanelLabel = (name) => (name === 'Overview' ? 'Summary' : name);
/** The agent's client detail, by sub id (contacts, trials, opportunities, offers, signings, representation, activity, …). */
export const clientTab = (page, subId) => openSub(page, subId, { nav: '[data-casenav="client"]', prefix: 'client' });
/** The agent's transaction workspace, by sub id (overview, parties, compliance, documents, messages, timeline). */
export const txTab = (page, subId) => openSub(page, subId, { nav: '[data-casenav="transaction"]', prefix: 'tx' });

/** The player app (web): open Opportunities, pick a category by id (journey, contact, trial, offer, signing, board) and optionally a page by its label. */
export async function playerCategory(page, cat, subLabel = null) {
  await page.click('a[href^="/opportunities"]').catch(() => {});
  await page.waitForTimeout(600);
  await page.click(`[data-testid="cat-${cat}"]`);
  await page.waitForTimeout(500);
  if (subLabel) await playerSub(page, subLabel);
}
/** The page tabs of the open category (the bottom tab bar is a tablist too, so the locator is scoped to the row under the category pills). */
export const playerTabs = (page) => page.locator('[data-testid="case-categories"] + [role="tablist"]');
export async function playerSub(page, subLabel) {
  await playerTabs(page).getByRole('tab', { name: subLabel, exact: true }).click();
  await page.waitForTimeout(500);
}
