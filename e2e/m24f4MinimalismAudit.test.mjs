// M24F.4 — static minimalism gates. No browser: the source tree is the evidence.
// Run from e2e/: node m24f4MinimalismAudit.test.mjs
//
//  1. Player root screens carry no greeting, no day/date line, no "View your
//     Passport" and no "Verified clubs can see you" in the header; the joined
//     line renders only from a real creation date;
//  2. banned helper strings never render on a root (the Combine root is names
//     only; the Box Cam root carries no setup instructions; the Development
//     root no feedback paragraph; the Offer root no conditions);
//  3. no seconds anywhere (every timestamp goes through time.ts / design-system
//     time.ts); no system font as a primary face; zero product emoji;
//  4. the Grassroots radar read state is a line, not an input; a squad row has
//     no bordered name chip;
//  5. the portals' Nobody Missed is a coverage tool (ring + rows) and the
//     Director Dashboard carries its executive layer while every panel keeps
//     its limitation;
//  6. the audit document lists every crawled screen and leaves no failing
//     screen without a fix or an accepted reason.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0; const failures = [];
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else { failures.push(m); console.log(`✗ ${m}`); } };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
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
/** Source order: `needle` appears only after `marker` (so it renders inside the control the marker opens). */
const after = (src, needle, marker) => { const a = src.indexOf(needle); const b = src.indexOf(marker); return a > 0 && b > 0 && a > b; };

// ------------------------------------------------------------ 1. the Player Home header
const home = strip(read('scoutbox-player/src/app/(tabs)/discover.tsx'));
const i18n = read('scoutbox-player/src/i18n.ts');
ok(!/homeMorning|homeAfternoon|homeEvening|Good morning|Good afternoon|Good evening/.test(home), 'Home: no greeting');
ok(!/toLocaleDateString\([^)]*weekday/.test(home) && !/dateLine/.test(home), 'Home: no day / date line');
ok(!/View your Passport|homeViewPassport/.test(home), 'Home: no "View your Passport" in the header');
ok(after(home, 'Verified clubs can see you', 'testID="home-visibility"'), 'Home: "Verified clubs can see you" renders only inside the visibility row, never in the header');
ok(/testID="home-identity"/.test(home) && /testID="home-availability"/.test(home) && /testID="home-joined"/.test(home), 'Home: identity block carries the name, the availability and the joined line');
ok(/typeof me\.createdAt === 'number' && me\.createdAt > 0 \? fmtMonthYear\(me\.createdAt\) : null/.test(home), 'Home: the joined line comes from the record\'s creation date only — never invented');
ok(/testID="home-primary"/.test(home) && /testID="home-activity"/.test(home) && /testID="home-activity-all"/.test(home) && /slice\(0, 3\)/.test(home), 'Home: one current action, three recent events, "View all activity"');
ok(fs.existsSync(path.join(ROOT, 'scoutbox-player/src/app/activity.tsx')) && /activity-group-\$\{g\.key\}/.test(read('scoutbox-player/src/app/activity.tsx')) && /activityToday|activityThisWeek|activityEarlier/.test(read('scoutbox-player/src/app/activity.tsx')), 'Activity: its own page, grouped Today / This week / Earlier');
ok(/createdAt/.test(read('scoutbox-player/src/data/types.ts')) && /createdAt: Date\.UTC/.test(read('scoutbox-player/src/data/mockClient.ts')), 'Me.createdAt is typed; the demo fixtures set an explicit creation date');

// ------------------------------------------------------------ 2. roots carry no helper strings
const combine = strip(read('scoutbox-player/src/components/CombineSection.tsx'));
const rootCombine = combine.slice(combine.indexOf('<SectionTitle>{pt(\'cmbTitle\')}'));
ok(/testID="combine-exercises"/.test(combine) && /testID={`combine-protocol-\$\{x\.id\}`}/.test(combine), 'Combine root: exercise rows');
ok(!/p\.description|setupRequirements|scoringMethod|safetyNotes|cmbNotSupported\b|measuredValue|a\.display/.test(rootCombine.split('</>')[0]), 'Combine root: names only — no description, result, unit or capability note on the root');
ok(/testID="combine-detail"/.test(combine) && /testID="combine-latest"/.test(combine) && /testID="combine-status"/.test(combine) && /testID="combine-instructions"/.test(combine) && /testID="combine-history"/.test(combine), 'Combine detail: latest result, status, instructions and history behind the row');
const boxcam = strip(read('scoutbox-player/src/components/M16Sections.tsx'));
ok(after(boxcam, "pt('bcSetupHint')", 'testID="boxcam-how"') && after(boxcam, "pt('m16providerNote')", 'testID="boxcam-how"'), 'Box Cam root: setup hint and provider note sit behind "How Box Cam works"');
ok(/testID="boxcam-latest"/.test(boxcam) && /testID="boxcam-start"/.test(boxcam) && /testID="boxcam-recent"/.test(boxcam) && /slice\(0, 3\)/.test(boxcam) && /TrainingVisual bare/.test(boxcam), 'Box Cam root: the visual, the latest session row, Start session, three recent rows');
ok(/m16state_unable_to_verify: 'Unable to verify'/.test(i18n), 'Box Cam: the refusal state still reads "Unable to verify"');
const dev = strip(read('scoutbox-player/src/components/M21Sections.tsx'));
const devRoot = dev.slice(dev.indexOf('testID="dev-root"'));
ok(/testID="dev-focus"/.test(devRoot) && /testID="dev-feedback"/.test(devRoot) && /testID="dev-progress"/.test(devRoot) && /testID="dev-history"/.test(devRoot), 'Development root: Current focus / Latest feedback / Progress / History rows');
ok(!/ReviewCard|GoalCard|ActionRow/.test(devRoot) && /clip\(/.test(devRoot), 'Development root: no feedback paragraph, no goal card — one clipped line per row');
const passport = strip(read('scoutbox-player/src/components/M15Sections.tsx'));
ok(/testID="passport-timeline"/.test(passport) && /hint={count\(p\.timeline\.length/.test(passport) && /testID="passport-achievements"/.test(passport) && /hint={count\(p\.achievements\.length/.test(passport), 'Passport root: Timeline and Achievements are rows with counts');
ok(/m15conflictShort: 'Club record needs review'/.test(i18n), 'Passport: a conflict reads "Club record needs review"');
const offer = strip(read('scoutbox-player/src/components/M23Offer.tsx'));
ok(after(offer, "pt('offerConditions')", 'offer-terms-') && after(offer, "pt('offerOlderRevisions')", 'offer-terms-') && after(offer, "pt('offerMessage')", 'offer-terms-'), 'Offer root: conditions, the club message and earlier revisions sit behind "View terms"');
ok(/offerNotSignature: 'Offer acceptance is not a signature\.'/.test(i18n) && /testID={`offer-not-signature-\$\{o\.id\}`}/.test(offer), 'Offer root: one quiet line says accepting is not a signature');
ok(/Kicker>\{pt\('offerKicker'\)\}/.test(offer) && /fontSize: 22/.test(offer), 'Offer root: kicker and the club set large');
const profile = strip(read('scoutbox-player/src/app/(tabs)/profile.tsx'));
ok(/testID="evidence-root"/.test(profile) && /testID="evidence-video-row"/.test(profile) && /testID="evidence-combine-row"/.test(profile) && /testID="evidence-references-row"/.test(profile) && /testID="evidence-attendance-row"/.test(profile) && /testID="evidence-latest-thumb"/.test(profile), 'Evidence root: latest clip as a picture, one row per kind with its count');
ok(after(profile, 'WebVideo src={src}', 'page === \'video\''), 'Evidence: the clips play one tap deep, not on the root');

// ------------------------------------------------------------ 3. time, font, emoji
const seconds = [];
for (const f of files.filter((p) => /\.(ts|tsx)$/.test(p))) {
  const s = strip(fs.readFileSync(f, 'utf8'));
  // a formatter that only feeds formatToParts (zone arithmetic) renders nothing
  if (/second: '2-digit'|second: 'numeric'|toISOString\(\)[^;]*\}<\/|toLocaleTimeString\(\)/.test(s) && !/time\.ts$/.test(f) && !/formatToParts/.test(s)) seconds.push(rel(f));
}
ok(seconds.length === 0, `no screen formats seconds (${seconds.join(', ') || 'none'})`);
const fontHits = [];
for (const f of files.filter((p) => /\.(css|tsx|ts)$/.test(p))) {
  const s = strip(fs.readFileSync(f, 'utf8'));
  for (const m of s.matchAll(/font-family:\s*([^;]+);/g)) { const v = m[1]; if (!/var\(--sb-font|Inter|inherit|monospace|'Albert Sans'|AlbertSans/.test(v)) fontHits.push(`${rel(f)}: ${v.slice(0, 40)}`); }
  for (const m of s.matchAll(/fontFamily:\s*'([^']+)'/g)) { if (!/^Inter|monospace|AlbertSans|inherit/.test(m[1])) fontHits.push(`${rel(f)}: ${m[1]}`); }
}
ok(fontHits.length === 0, `Inter is the only primary face (Albert Sans for the wordmark, monospace for machine strings) (${fontHits.slice(0, 3).join(' | ') || 'clean'})`);
ok(/--sb-font: 'Inter'/.test(read('design-system/tokens.css')) && /--sb-font-brand: 'Albert Sans'/.test(read('design-system/tokens.css')), 'tokens: --sb-font is Inter; the brand face is the wordmark only');
const PICTO = /\p{Extended_Pictographic}/u; const emoji = [];
for (const f of files) { const s = strip(fs.readFileSync(f, 'utf8')); for (const [i, l] of s.split('\n').entries()) if (PICTO.test(l) && !/[✓✕○➤⊘◷↻✗›⌄▲▼]/.test(l.match(PICTO)[0])) emoji.push(`${rel(f)}:${i + 1}`); }
ok(emoji.length === 0, `zero product emoji (${emoji.slice(0, 3).join(', ') || 'clean'})`);

// ------------------------------------------------------------ 4. Grassroots radar and squad
const grass = strip(read('scoutbox-grassroots/src/screens.tsx'));
ok(/data-testid="radar-read"/.test(grass) && /data-testid="radar-edit-link"/.test(grass) && after(grass, 'aria-label="Positions you are looking for"', 'editingRadar ?'), 'Grassroots radar: a read line with Edit; the input renders only while editing');
ok(/className="list-row squad-row"/.test(grass) && /className="p-avatar"/.test(grass) && !/<button style=\{\{ padding: 0, color: 'var\(--accent-2\)', fontWeight: 600 \}\} onClick=\{\(\) => openPlayer\(e\.playerId!\)\}>\{e\.name\}<\/button>/.test(grass), 'Grassroots squad: flat rows with initials — no bordered name chip');
ok(/data-testid="squad-gap-radar"/.test(grass) && /className="linklike"/.test(grass), 'Grassroots squad: the radar action is a text link');
ok(/lookingFor: \['GK', 'CDM', 'CM', 'ST', 'CF'\]/.test(read('scoutbox-grassroots/src/demo.ts')), 'Grassroots demo: the club carries the positions it told the radar');

// ------------------------------------------------------------ 5. Nobody Missed and the Director Dashboard (both portals)
for (const app of ['club', 'grassroots']) {
  const nm = strip(read(`scoutbox-${app}/src/m18Screens.tsx`));
  ok(/function CoverageRing/.test(nm) && /<CoverageRing percent={coverage\.coveragePercent}/.test(nm) && /aria-label={t\('m18\.nm\.coverageLabel'\)}/.test(nm) && /className="stat"/.test(nm), `${app}: Nobody Missed draws the coverage ring from the server's percent beside the four counts`);
  ok(/function CandidateRow/.test(nm) && /data-testid="nm-row-toggle"/.test(nm) && after(nm, "t('m18.nm.whyShown')", 'open && (') && /data-group={g\.key}/.test(nm), `${app}: candidates are compact rows grouped by state; "Why shown" opens behind the row`);
  ok(!/t\('m18\.nm\.intro'\)/.test(nm) && /t\('m18\.nm\.notQuality'\)/.test(nm), `${app}: no intro paragraph; the one honesty sentence stays`);
  ok(!/matchScore|rankScore|\.score\b/.test(nm.slice(nm.indexOf('NOBODY MISSED'), nm.indexOf('RECRUITMENT BRIEFS'))), `${app}: no invented ranking score on Nobody Missed`);
  const dash = strip(read(`scoutbox-${app}/src/m20Screens.tsx`));
  ok(/function Executive/.test(dash) && /data-kpis="true"/.test(dash) && /data-visual="funnel"/.test(dash) && /data-visual="time"/.test(dash) && /data-visual="coverage"/.test(dash) && /data-visual="attention"/.test(dash), `${app}: the Director Dashboard carries the executive layer (counts, funnel, time by stage, coverage, needs attention)`);
  ok(/kpis.*=.*\[/.test(dash) && (dash.match(/\{ id: '[a-z_]+', label: t\('m20\.kpi\./g) ?? []).length === 4, `${app}: exactly four counts`);
  ok(!/t\('m20\.subtitle'\)/.test(dash) && /data-principle="true"/.test(dash), `${app}: the one-sentence header is the governing sentence`);
  ok(/<Limitation text={metric\.limitation} \/>/.test(dash) && /data-limitation="true"/.test(dash), `${app}: every panel still prints its limitation`);
  ok(/\.slice\(0, 5\)/.test(dash) && /hashForRoom\(r\.roomId\)/.test(dash), `${app}: Needs attention is at most five lines that open the room`);
  ok(!/Math\.round\(\(\(r\.value\) \/ max\) \* 100\)[^;]*rate/.test(dash) && !/percentChange\s*=/.test(dash), `${app}: the client computes no rate of its own`);
}
ok(/\.dash-bar-fill \{[^}]*var\(--sb-green-text\)/.test(read('design-system/platform.css')) && /\.nm-ring/.test(read('design-system/platform.css')), 'platform.css: bars and rings use the ScoutBox green; no rainbow');

// ------------------------------------------------------------ 6. the audit document
const auditPath = path.join(ROOT, 'M24F4_ALL_APP_SCREEN_AUDIT.md');
ok(fs.existsSync(auditPath), 'M24F4_ALL_APP_SCREEN_AUDIT.md exists');
if (fs.existsSync(auditPath)) {
  const doc = fs.readFileSync(auditPath, 'utf8');
  const rows = doc.split('\n').filter((l) => /^\| (Pro|Grassroots|Agent|Trust & Safety|Player|Guardian) \|/.test(l));
  const failing = rows.filter((l) => { const cells = l.split('|').map((c) => c.trim()); const statusAfter = cells[cells.length - 3] ?? ''; return /TOO |NEEDS/.test(statusAfter) && !/ACCEPTED/.test(statusAfter); });
  ok(rows.length >= 150, `the audit lists every crawled screen (${rows.length} rows)`);
  ok(failing.length === 0, `no screen is left failing without a fix or an accepted reason (${failing.length})`);
  ok(/\| App \| Route \| Screen \| Status before \| Text issue \| Visual issue \| Change \| Status after \|/.test(doc), 'the audit carries the mandated columns');
}
for (const d of ['M24F4_MINIMAL_PRODUCT_RULES.md', 'M24F4_PLAYER_VISUAL_RESET.md', 'M24F4_DIRECTOR_DASHBOARD.md']) ok(fs.existsSync(path.join(ROOT, d)), `${d} exists`);

console.log(`\nm24f4MinimalismAudit: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
