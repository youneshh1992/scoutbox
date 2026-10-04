// M24F.3 — static minimalism gates. No browser: the source tree is the evidence.
// Run from e2e/: node m24f3DensityAudit.test.mjs
//
//  1. root screens carry no banned long pattern (policy version, provenance
//     prose, scheduler talk, full disclaimers) unless a Disclosure holds it;
//  2. the opportunity preview is at most two lines; the inbox preview is one;
//  3. the Trust root shows no policy version; the Passport root no disclaimer;
//     the timeline root no "Where is this from?";
//  4. no seconds anywhere: every machine timestamp goes through time.ts;
//  5. a trial message carries the trial token (colour AND the word "Trial"),
//     and the trial colours meet WCAG AA where they carry text;
//  6. the portals route every hint through Hint / About (nothing long renders
//     as a bare paragraph), the Player through Disclosure;
//  7. the audit document exists and leaves no TOO DENSE screen without a fix.
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
    else if (/\.(ts|tsx)$/.test(f) && !SKIP.test(f)) out.push(p);
  }
  return out;
}
const APPS = ['scoutbox-club/src', 'scoutbox-grassroots/src', 'scoutbox-agent/src', 'scoutbox-admin/src', 'scoutbox-player/src', 'design-system'];
const files = APPS.flatMap((r) => walk(path.join(ROOT, r)));
const rel = (p) => path.relative(ROOT, p);

// ------------------------------------------------------------ 1. roots: banned long patterns
const trust = read('scoutbox-player/src/components/TrustProfileSection.tsx');
const passport = read('scoutbox-player/src/components/M15Sections.tsx');
const inbox = read('scoutbox-player/src/app/(tabs)/inbox.tsx');
const board = read('scoutbox-player/src/components/M12Sections.tsx');
const fit = read('scoutbox-player/src/components/M13Sections.tsx');
const i18n = read('scoutbox-player/src/i18n.ts');
const after = (src, needle, marker) => { const a = src.indexOf(needle); const b = src.indexOf(marker); return a > 0 && b > 0 && a > b; };
ok(after(trust, 'policyVersion', 'testID="trust-about"'), 'Trust: the policy version renders only inside "About" (after the trust-about Disclosure opens)');
ok(/pt\('trsEvidenceOnly'\)/.test(trust) && /testID="trust-why"/.test(trust) && /pt\('trsBreakdown'\)/.test(trust) && /testID="trust-score"/.test(trust), 'Trust root: score, band, "Evidence confidence only", "View breakdown" — nothing else');
ok(after(trust, 'trust-gaps', 'testID="trust-why"') && after(trust, 'trust-strengths', 'testID="trust-why"'), 'Trust: strengths and gaps sit behind "View breakdown"');
ok(after(passport, '{p.note}', 'testID="passport-about"'), 'Passport: the disclaimer renders only inside "About Passport"');
ok(/testID="passport-root"/.test(passport) && /testID="passport-club"/.test(passport) && /testID="passport-availability"/.test(passport) && /testID="passport-evidence"/.test(passport) && /pt\('m15coverageWord'/.test(passport), 'Passport root: verified status, current club, availability, evidence in one word');
ok(/testID="passport-conflict"/.test(passport) && /pt\('m15conflictShort'\)/.test(passport), 'Passport: a conflict is one line with a Review control; the full text sits behind it');
ok(/testID="passport-evidence-detail"/.test(passport) && /pt\('m15viewEvidence'\)/.test(passport), 'Passport: evidence counts and gaps sit behind "View evidence"');
ok(!/m15whyTap/.test(i18n) && !/Where is this from/.test(strip(passport)) && /EventRow/.test(passport) && after(passport, 'provenanceCopy', 'testID={`passport-event-'), 'Timeline root: no "Where is this from?" — provenance renders inside each opened row');
ok(/passport-timeline-more/.test(passport) && /slice\(0, 4\)|, 4\)/.test(passport), 'Timeline root: a four-row preview with "Show all"');
ok(/testID={`passport-achievement-/.test(passport) && /testID="passport-add-achievement"/.test(passport), 'Achievements: simple rows; adding sits behind a Disclosure');
for (const [key, label] of [['m13fitNote', 'the fit explanatory note'], ['m15whyTap', 'the timeline tap hint']]) ok(!new RegExp(`\\b${key}\\b`).test(i18n), `Player i18n: ${label} (${key}) is gone`);

// ------------------------------------------------------------ 2. previews
const ui = read('scoutbox-player/src/components/ui.tsx');
const previewRow = ui.slice(ui.indexOf('export function PreviewRow'), ui.indexOf('export function DetailLink'));
ok(/numberOfLines=\{1\}>\{title\}/.test(previewRow) && /numberOfLines=\{1\}>\{line\}/.test(previewRow), 'PreviewRow: the name and the preview are one line each (numberOfLines=1)');
ok(/<PreviewRow/.test(read('scoutbox-player/src/components/Threads.tsx')) && (inbox.match(/<PreviewRow/g) ?? []).length >= 3, 'Inbox: conversations, requests and events are PreviewRows');
const inboxTabs = [...inbox.matchAll(/\{ key: '(all|unread|requests)'/g)].map((m) => m[1]);
ok(inboxTabs.length === 3 && inboxTabs.join(',') === 'all,unread,requests', `Inbox: exactly the three tabs All / Unread / Requests (${inboxTabs.join(' / ')})`);
ok(/hint=\{`\$\{[^\n]*humanDate\([^\n]*`\}/.test(board) && !/hint=\{`[^`]*\n[^`]*`\}/.test(board), 'Opportunity board: the preview is one templated line (title / club · date · distance · state)');
ok(/testID=\{`board-view-\$\{/.test(board) && /pt\('boardRequirements'\)/.test(board) && /testID=\{`board-apply-\$\{/.test(board), 'Opportunity board: description, requirements and Apply sit behind "View details"');
ok(/pt\('m13fitLine'\)/.test(fit) && /testID=\{`fit-check-\$\{/.test(fit) && /testID=\{`fit-why-\$\{/.test(fit), 'Opportunity fit: one line + "Check fit"; reasons behind "Why"');
ok(/testID=\{`req-details-\$\{/.test(inbox) && /pt\('inboxViewFullMessage'\)/.test(inbox) && /testID=\{`req-accept-\$\{/.test(inbox) && /testID=\{`req-decline-\$\{/.test(inbox), 'Request detail: Accept and Decline visible; the full message, venue and instructions behind "View full message"');
ok(after(inbox, 'testID={`req-message-', 'testID={`req-details-'), 'Request detail: the message body renders inside the Disclosure');
const guardian = read('scoutbox-player/src/app/guardian.tsx');
ok(/testID=\{`req-details-\$\{/.test(guardian) && /pt\('inboxViewFullMessage'\)/.test(guardian), 'Guardian request card: message and notes behind "View full message"');
ok(/inboxSafety: 'You control who can contact you\.'/.test(i18n) && /inboxLearnMore: 'Learn more'/.test(i18n), 'Safeguarding copy: "You control who can contact you. Learn more →"');

// ------------------------------------------------------------ 3. time
const playerTime = read('scoutbox-player/src/time.ts'); const dsTime = read('design-system/time.ts');
ok(/export function relTime/.test(playerTime) && /fmtDayTime/.test(playerTime) && /export function fmtStamp/.test(dsTime) && /export const fmtClock/.test(dsTime), 'time.ts: relTime / fmtDayTime (Player) and fmtStamp / fmtClock (portals) exist');
ok(!/second/.test(strip(playerTime + dsTime)), 'time.ts: seconds are never formatted');
const secondsHits = [];
for (const f of files) { const s = strip(fs.readFileSync(f, 'utf8')); s.split('\n').forEach((l, i) => { if (/toLocaleString\(\)|toLocaleTimeString\(\)|toISOString\(\)\.replace\('T'|second: '2-digit'|:ss\b/.test(l) && !/formatToParts|Intl\.DateTimeFormat\('en-GB', \{ timeZone: zone/.test(l)) secondsHits.push(`${rel(f)}:${i + 1}`); }); }
ok(secondsHits.length === 0, `no machine timestamp with seconds in the five applications (${secondsHits.slice(0, 4).join(', ') || 'none'})`);

// ------------------------------------------------------------ 4. the trial token
const theme = read('scoutbox-player/src/theme.ts');
const block = (name) => { const m = theme.match(new RegExp(`${name}[^{]*\\{([\\s\\S]*?)\\n  \\}`)); return m ? m[1] : ''; };
const pal = (b) => Object.fromEntries([...b.matchAll(/(\w+): '(#[0-9a-fA-F]{6})'/g)].map((m) => [m[1], m[2].toLowerCase()]));
const light = pal(theme.slice(theme.indexOf('light:'), theme.indexOf('dark:'))); const dark = pal(theme.slice(theme.indexOf('dark:'), theme.indexOf('export const AUTH_PANEL')));
const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
for (const [name, p] of [['light', light], ['dark', dark]]) {
  ok(p.trial && p.trialBg && p.trialInk && p.offer && p.signing, `theme ${name}: trial / offer / signing accents declared`);
  const r = p.trialInk && p.trialBg ? ratio(p.trialInk, p.trialBg) : 0;
  ok(r >= 4.5, `theme ${name}: the "Trial" label (${p.trialInk} on ${p.trialBg}) meets AA — ${r.toFixed(1)}:1`);
}
ok(/#e9c46a/i.test(dark.trial ?? '') && /#b08a1c|#c9a227|#ddbb55/i.test(light.trial ?? ''), 'the trial accent is the warm gold / amber family (#E9C46A dark; a darker gold on paper)');
ok(/accent=\{r\.type === 'trial' \? 'trial'/.test(inbox) || /accent=\{[^}]*'trial'/.test(inbox), 'Inbox: a trial request row carries the trial accent');
ok(/accentLabel=\{[^}]*pt\('inboxTrialLabel'\)/.test(inbox) && /inboxTrialLabel: 'Trial'/.test(i18n), 'Inbox: the trial row carries the word "Trial" — never colour alone');
ok(/`row-accent-\$\{accent\}`/.test(previewRow) && /accentLabel/.test(previewRow), 'PreviewRow: the accent edge and its label are part of the primitive');
ok(/--sb-trial:/.test(read('design-system/tokens.css')) && /\.f-preview\.trial/.test(read('design-system/platform.css')), 'portals: trial tokens and the trial preview rule exist');

// ------------------------------------------------------------ 5. portals: Hint / About
const about = read('design-system/About.tsx');
ok(/export const LONG_HINT = 140/.test(about) && /export function Hint/.test(about) && /export function About/.test(about), 'design-system/About.tsx: Hint folds anything longer than 140 characters behind About');
const rawHints = [];
for (const f of files.filter((p) => /scoutbox-(club|grassroots|agent|admin)\/src/.test(p))) {
  const s = fs.readFileSync(f, 'utf8');
  s.split('\n').forEach((l, i) => { const m = l.match(/<p className="pagehint"[^>]*>([^<{]{141,})<\/p>/); if (m) rawHints.push(`${rel(f)}:${i + 1}`); });
}
ok(rawHints.length === 0, `portals: no bare pagehint paragraph over 140 characters (${rawHints.slice(0, 3).join(', ') || 'none'})`);
ok(/\.f-about > summary/.test(read('design-system/platform.css')), 'portals: the About control is styled as a quiet link with a chevron');
const longLiterals = [];
for (const f of files.filter((p) => /scoutbox-(club|grassroots|agent|admin)\/src\/.*\.tsx$/.test(p))) {
  const s = fs.readFileSync(f, 'utf8');
  // a static notice over 140 chars that is NOT inside an About / Hint
  for (const m of s.matchAll(/<div className="notice"[^>]*>\s*\n?\s*([A-Z][^<{]{141,})/g)) { const before = s.slice(Math.max(0, m.index - 80), m.index); if (!/f-about|<Hint/.test(before)) longLiterals.push(`${rel(f)}: ${m[1].slice(0, 50)}…`); }
}
ok(longLiterals.length === 0, `portals: no static notice over 140 characters outside About (${longLiterals.slice(0, 3).join(' | ') || 'none'})`);

// ------------------------------------------------------------ 6. Player: Disclosures hold the explanations
for (const [file, needles, label] of [
  ['scoutbox-player/src/components/M23Offer.tsx', ['testID="about-offers"'], 'Offer: "About offers"'],
  ['scoutbox-player/src/components/M23Signing.tsx', ['testID="about-signing"'], 'Signing: "About signing"'],
  ['scoutbox-player/src/components/M16Sections.tsx', ['testID="boxcam-about"', 'About Box Challenges'], 'Box Cam: provider and challenge disclaimers behind About'],
  ['scoutbox-player/src/components/M21Sections.tsx', ['About this target', 'About these counts', 'About this plan'], 'Development: target, count / reminder and plan explanations behind About'],
  ['scoutbox-player/src/components/CombineSection.tsx', ['About this result', 'About this request'], 'Combine: result and request notes behind About'],
  ['scoutbox-player/src/components/AgentTransactionSection.tsx', ['About transactions'], 'Transactions: the introduction behind About'],
  ['scoutbox-player/src/app/guardian.tsx', ['How pairing works'], 'Guardian: pairing instructions behind a Disclosure'],
]) ok(needles.every((n) => read(file).includes(n)), label);
ok(!/Every action is on the ledger/.test(read('scoutbox-player/src/app/(tabs)/discover.tsx')), 'Home: no ledger sentence on the root');

// ------------------------------------------------------------ 7. the audit document
const auditPath = path.join(ROOT, 'M24F3_SCREEN_DENSITY_AUDIT.md');
ok(fs.existsSync(auditPath), 'M24F3_SCREEN_DENSITY_AUDIT.md exists');
if (fs.existsSync(auditPath)) {
  const doc = fs.readFileSync(auditPath, 'utf8');
  const rows = doc.split('\n').filter((l) => /^\| (Pro|Grassroots|Agent|Trust & Safety|Player|Guardian) \|/.test(l));
  const open = rows.filter((l) => /TOO DENSE/.test(l) && !/\| (Folded|Shortened|Kept|Clipped|Removed|Moved)[^|]*\|\s*$/.test(l));
  ok(rows.length >= 60, `the audit lists every crawled screen (${rows.length} rows)`);
  ok(open.length === 0, `no TOO DENSE screen is left without a fix or an accepted reason (${open.length})`);
  ok(/\| App \| Route \| Screen \| Visible text/.test(doc), 'the audit carries the mandated columns');
}

console.log(`\nm24f3DensityAudit: ${passed} checks passed${failures.length ? `, ${failures.length} FAILED` : ''}`);
if (failures.length) process.exit(1);
