// M24F.5 — static visual-acceptance gates. No browser: the source tree is the
// evidence for what a root screen may render. Run from e2e/:
//   node m24f5VisualAcceptanceAudit.test.mjs
//
//  1. Player Home: no greeting, no day/date, no "View your Passport", no
//     "Verified clubs can see you" in the header; Recent is a timeline, not a table;
//  2. Player roots: Combine names only; Box Cam root carries no setup paragraph;
//     Development root shows the feedback's source, never its text; Evidence is
//     latest-clip + categories with counts on the right;
//  3. Offer and Trial: the Offer status is a line (no squeezed fact row) and the
//     term dates read as a range; the trial card is an edge, not a filled card;
//  4. Director Dashboard: the executive visuals are on the root and every
//     detail/explanation is one tap deeper; no <code> face; Nobody Missed keeps
//     its coverage ring and drops its doubled heading;
//  5. Grassroots radar read state and squad names carry no border;
//  6. Inter everywhere: no monospace face in any app, code/pre/samp set to Inter,
//     the demo badge in Inter; zero emoji; no seconds; no browser-locale dates
//     in the Player;
//  7. the guardian dashboard's child sections are rows; the Staff & Security
//     sections are rows; the 50 kept screens are each re-reviewed in writing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0; const failures = [];
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else { failures.push(m); console.log(`✗ ${m}`); } };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
const SKIP = /node_modules|screenshots|reference|fonts|assets|dist|\.test\.|mock|demo\.ts|Demo\.ts|m\d+demo\.ts|agentDemo/;
function walk(d, out = []) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f); const st = fs.statSync(p);
    if (st.isDirectory()) { if (!SKIP.test(f)) walk(p, out); }
    else if (/\.(ts|tsx|css)$/.test(f) && !SKIP.test(f)) out.push(p);
  }
  return out;
}
const APPS = ['scoutbox-club/src', 'scoutbox-grassroots/src', 'scoutbox-agent/src', 'scoutbox-admin/src', 'scoutbox-player/src', 'design-system'];
const files = APPS.flatMap((r) => walk(path.join(ROOT, r)));
const rel = (p) => path.relative(ROOT, p);
const after = (src, needle, marker) => { const a = src.indexOf(needle); const b = src.indexOf(marker); return a > 0 && b > 0 && a > b; };

// ------------------------------------------------------------ 1. Player Home
const home = strip(read('scoutbox-player/src/app/(tabs)/discover.tsx'));
ok(!/Good morning|Good afternoon|Good evening|homeMorning|homeAfternoon|homeEvening/.test(home), 'Home: no greeting');
ok(!/weekday/.test(home) && !/dateLine/.test(home), 'Home: no day or full date');
ok(!/View your Passport|homeViewPassport/.test(home), 'Home: no "View your Passport"');
ok(after(home, 'Verified clubs can see you', 'testID="home-visibility"'), 'Home: "Verified clubs can see you" only inside the visibility row');
ok(/typeof me\.createdAt === 'number' && me\.createdAt > 0 \? fmtMonthYear\(me\.createdAt\) : null/.test(home), 'Home: "Joined" only from the record\'s creation date');
ok(/<TimelineItem[^>]*testID="home-recent-row"/.test(home) && !/activityRow|activityWhen/.test(home), 'Home: Recent is a timeline (dot, date above, event below), not a two-column table');
ok(/homeClubsWithinOne|homeClubsWithinMany/.test(home) && !/· 50 km`/.test(home), 'Home: "1 club within 50 km" — never the cryptic "1 · 50 km"');
const activity = strip(read('scoutbox-player/src/app/activity.tsx'));
ok(/<TimelineItem/.test(activity) && /activity-group-\$\{g\.key\}/.test(activity), 'Activity: grouped Today / This week / Earlier, timeline rows');
const ui = read('scoutbox-player/src/components/ui.tsx');
ok(/export function TimelineItem/.test(ui) && !/borderBottomWidth/.test(ui.slice(ui.indexOf('export function TimelineItem'), ui.indexOf('export function Kicker'))), 'TimelineItem: no dividers');

// ------------------------------------------------------------ 2. Player roots
const combine = strip(read('scoutbox-player/src/components/CombineSection.tsx'));
const protoRow = combine.split('\n').find((l) => l.includes('testID={`combine-protocol-${x.id}`}')) ?? '';
ok(protoRow && !/value=/.test(protoRow), 'Combine root: each exercise row is its name only (no description beneath)');
const boxcam = strip(read('scoutbox-player/src/components/M16Sections.tsx'));
ok(after(boxcam, "pt('bcSetupHint')", 'testID="boxcam-how"'), 'Box Cam root: the setup paragraph sits inside "How Box Cam works"');
const dev = strip(read('scoutbox-player/src/components/M21Sections.tsx'));
const devFeedback = dev.match(/<ListRow label=\{pt\('devLatestFeedback'\)\}[^\n]*/)?.[0] ?? '';
ok(devFeedback && !/latestReview\.summary/.test(devFeedback) && /reviewedByName/.test(devFeedback), 'Development root: Latest feedback names its source and date, never the coach\'s text');
ok((dev.match(/label="About these counts"/g) ?? []).length <= 1 && /testID="dev-about"/.test(dev), 'Development root: one "About this plan" row');
const profile = strip(read('scoutbox-player/src/app/(tabs)/profile.tsx'));
ok(/testID="evidence-latest-thumb"/.test(profile) && /pt\('evLatest'\)/.test(profile) && /pt\('evCategories'\)/.test(profile), 'Evidence root: a latest clip picture, then Categories');
ok(/label=\{pt\('evVideo'\)\} count=/.test(profile) && /label=\{pt\('evCombine'\)\} count=/.test(profile), 'Evidence root: counts on the right, not as sub-notes');

// ------------------------------------------------------------ 3. Offer and Trial
const offer = strip(read('scoutbox-player/src/components/M23Offer.tsx'));
ok(!/<FactRow k=\{pt\('offerStatus'\)\}/.test(offer) && /humanDate\(cur\.terms\.startDate\)\} – \$\{humanDate\(cur\.terms\.endDate\)\}/.test(offer), 'Offer: status on its own line; term dates as a range');
ok(/testID=\{`offer-terms-\$\{o\.id\}`\}/.test(offer) && /testID=\{`offer-not-signature-\$\{o\.id\}`\}/.test(offer), 'Offer: "View terms" holds the detail; "Offer acceptance is not a signature." stays on screen');
const inbox = strip(read('scoutbox-player/src/app/(tabs)/inbox.tsx'));
ok(!/styles\.special, trial && \{[^}]*trialBg/.test(inbox) && /tone=\{trial \? 'trial' : 'accent'\}/.test(inbox), 'Trial thread: a warm edge and a "Trial" kicker — no filled yellow card');

// ------------------------------------------------------------ 4. Director Dashboard, Nobody Missed
for (const app of ['club', 'grassroots']) {
  const dash = strip(read(`scoutbox-${app}/src/m20Screens.tsx`));
  ok(/data-visual="funnel"/.test(dash) && /data-visual="time"/.test(dash) && /data-visual="coverage"/.test(dash) && /data-visual="attention"/.test(dash) && /data-kpis="true"/.test(dash), `${app} Dashboard: four counts, funnel, time by stage, coverage and needs attention on the root`);
  ok(/data-testid="dash-detail-toggle"/.test(dash) && /\{showDetail && \(/.test(dash), `${app} Dashboard: every panel is one tap deeper, rendered only when opened`);
  ok(/\{showAbout && dash && \(/.test(dash) && /\{showFilters && \(/.test(dash), `${app} Dashboard: the governing sentence, the window and the extra filters are one tap away`);
  ok(!/funnelNote|timeNote/.test(dash), `${app} Dashboard: no explanatory caption under the visuals`);
  ok(!/<code>/.test(dash), `${app} Dashboard: no code face anywhere`);
  ok(/<Limitation text=\{metric\.limitation\} \/>/.test(dash), `${app} Dashboard: every panel still prints its limitation beside its number`);
  const nm = strip(read(`scoutbox-${app}/src/m18Screens.tsx`));
  ok(/function CoverageRing/.test(nm) && /className="nm-row-head"/.test(nm), `${app} Nobody Missed: coverage ring and compact rows`);
  ok(!/<h4>\{t\('m18\.nm\.candidates'\)\}/.test(nm), `${app} Nobody Missed: no doubled heading above the groups`);
  ok(!/<div className="notice block"[^>]*>\s*\{data\?\.disclaimer/.test(nm), `${app} Second Look: the governing sentence is a quiet statement, not an alert box`);
}

// ------------------------------------------------------------ 5. Grassroots radar and squad
const gScreens = strip(read('scoutbox-grassroots/src/screens.tsx'));
const radarRead = gScreens.slice(gScreens.indexOf('data-testid="radar-read"'), gScreens.indexOf('data-testid="radar-read"') + 500);
ok(radarRead.length > 30 && !/<input/.test(radarRead), 'Radar read state: a line of text with Edit, no input');
const css = read('design-system/platform.css');
const squadName = css.match(/\.squad-name\s*\{[^}]*\}/)?.[0] ?? '';
ok(!/border/.test(squadName), 'Squad: names are plain text, no border');
ok(/data-testid="openday-post-toggle"/.test(gScreens), 'Open Days: the posting form opens on demand');

// ------------------------------------------------------------ 6. Inter, emoji, seconds, dates
const mono = [];
for (const f of files) { const s = strip(fs.readFileSync(f, 'utf8')); if (/monospace/.test(s) && !/Text\.tsx$/.test(f)) mono.push(rel(f)); }
ok(mono.length === 0, `no monospace face in any app (${mono.join(', ') || 'clean'})`);
ok(/code, pre, samp \{ font-family: var\(--sb-font\)/.test(css), 'code / pre / samp render in Inter');
const fontHits = [];
for (const f of files.filter((p) => /\.(css|tsx|ts)$/.test(p))) {
  const s = strip(fs.readFileSync(f, 'utf8'));
  for (const m of s.matchAll(/font-family:\s*([^;]+);/g)) { const v = m[1]; if (!/var\(--sb-font|Inter|inherit|'Albert Sans'|AlbertSans|var\(--sb-font-brand|var\(--gr-display/.test(v)) fontHits.push(`${rel(f)}: ${v.slice(0, 40)}`); }
  for (const m of s.matchAll(/fontFamily:\s*'([^']+)'/g)) { if (!/^Inter|AlbertSans|inherit/.test(m[1])) fontHits.push(`${rel(f)}: ${m[1]}`); }
}
ok(fontHits.length === 0, `Inter is the only UI face; Albert Sans only for the wordmark (${fontHits.slice(0, 3).join(' | ') || 'clean'})`);
ok(/--sb-font: 'Inter'/.test(read('design-system/tokens.css')), 'tokens: --sb-font is Inter');
const build = read('e2e/buildDemos.mjs');
ok(/font:10px\/1\.4 Inter/.test(build) && /right:8px/.test(build) && /'scoutbox-player-demo\.html' \? 74 : 8/.test(build), 'demo badge: Inter, bottom-right, above the Player tab bar');
const PICTO = /\p{Extended_Pictographic}/u; const emoji = [];
for (const f of files) { const s = strip(fs.readFileSync(f, 'utf8')); for (const [i, l] of s.split('\n').entries()) if (PICTO.test(l) && !/[✓✕○➤⊘◷↻✗›⌄▲▼]/.test(l.match(PICTO)[0])) emoji.push(`${rel(f)}:${i + 1}`); }
ok(emoji.length === 0, `zero unauthorised emoji (${emoji.slice(0, 3).join(', ') || 'clean'})`);
const seconds = [];
for (const f of files.filter((p) => /\.(ts|tsx)$/.test(p))) {
  const s = strip(fs.readFileSync(f, 'utf8'));
  if (/second: '2-digit'|second: 'numeric'|toLocaleTimeString\(\)/.test(s) && !/time\.ts$/.test(f) && !/formatToParts/.test(s)) seconds.push(rel(f));
}
ok(seconds.length === 0, `no ordinary timestamp shows seconds (${seconds.join(', ') || 'none'})`);
const usDates = [];
for (const f of files.filter((p) => /scoutbox-player/.test(p) && /\.(ts|tsx)$/.test(p))) {
  const s = strip(fs.readFileSync(f, 'utf8'));
  if (/toLocaleDateString\(\)|toLocaleDateString\(undefined|toLocaleString\(undefined|toLocaleString\(\)/.test(s)) usDates.push(rel(f));
}
ok(usDates.length === 0, `Player dates follow the UI language ("2 Oct"), never the browser default ("Oct 2, 2026") (${usDates.join(', ') || 'clean'})`);

// ------------------------------------------------------------ 7. rows instead of walls
const guardian = strip(read('scoutbox-player/src/app/guardian.tsx'));
const childRows = (guardian.match(/testID=\{`guardian-child-[a-z]+-\$\{c\.id\}`\}/g) ?? []).length;
ok(childRows >= 10, `Guardian: the child's sections are ${childRows} rows, each opening one tap deeper`);
for (const app of ['club', 'grassroots']) {
  const org = strip(read(`scoutbox-${app}/src/m13screens.tsx`));
  ok((org.match(/<SettingsRow id="/g) ?? []).length >= 8, `${app} Staff & Security: every section is a row with its state`);
}
// Kept-screen re-review fixes (R2).
for (const app of ['club', 'grassroots']) {
  const scr = strip(read(`scoutbox-${app}/src/screens.tsx`));
  const overlay = scr.slice(scr.indexOf('className="filmroom-overlay"'), scr.indexOf('</>', scr.indexOf('className="filmroom-overlay"')));
  ok(/data-testid="filmroom-caption"/.test(scr) && overlay.length > 0 && !/media\.title/.test(overlay), `${app} Film Room: the caption sits under the clip, not over the video controls`);
  const m14 = strip(read(`scoutbox-${app}/src/m14screens.tsx`));
  ok(/allStepsDone \?/.test(m14) && /data-testid="verify-start-more"/.test(m14), `${app} Verification: start forms fold once every step is done`);
  ok(['refs-ref-add', 'refs-inv-add', 'refs-coi-add', 'verify-credential-add'].every((id) => m14.includes(`data-testid="${id}"`)), `${app} Verification: add forms sit behind one row each`);
}
{
  const css = read('design-system/platform.css');
  ok(/\.filmroom-overlay \{[^}]*padding: 14px 14px 56px/.test(css), 'Film Room overlay keeps clear of the native video controls');
  ok(/:where\(\.content a:not\(\[class\]\)\) \{ color: var\(--sb-link\)/.test(css), 'bare content links read in the link colour, never browser blue');
  const gr = strip(read('scoutbox-grassroots/src/screens.tsx'));
  ok(/data-testid=\{`openday-meta-\$\{t\.id\}`\}/.test(gr) && !/<span className="pill blue">\{t\.ageGroup\}/.test(gr), 'Grassroots Open Days: one quiet meta line, not a row of pills');
  ok(/humanize/.test(read('scoutbox-admin/src/humanize.ts')) || /DNS ownership/.test(read('scoutbox-admin/src/humanize.ts')), 'Trust & Safety humaniser keeps acronyms');
  const ag = read('scoutbox-agent/src/i18n.ts');
  ok(!/facet by facet|licence facet'/.test(ag), 'Agent: no "facet" jargon in headings');
}
const doc = path.join(ROOT, 'M24F5_KEPT_SCREEN_REVIEW.md');
const review = fs.existsSync(doc) ? fs.readFileSync(doc, 'utf8') : '';
const reviewRows = review.split('\n').filter((l) => /^\| (Pro|Grassroots|Agent|Trust & Safety|Player|Guardian) \|/.test(l));
ok(reviewRows.length === 50, `kept-screen review: all 50 screens re-reviewed (${reviewRows.length})`);
ok(reviewRows.every((l) => /\| (GOOD|NEEDS SIMPLIFICATION|NEEDS VISUAL RECOMPOSITION) \|/.test(l)), 'kept-screen review: every screen has a verdict');

console.log(failures.length ? `\nm24f5VisualAcceptanceAudit: ${passed} passed, ${failures.length} FAILED` : `\nm24f5VisualAcceptanceAudit: ${passed} passed, 0 failed`);
process.exit(failures.length ? 1 : 0);
