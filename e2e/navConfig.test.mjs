// M15-Nav — navigation configuration acceptance (no browser).
// Compiles the REAL nav.ts of Pro and Grassroots with esbuild and asserts:
// every legacy destination is mapped exactly once, the resolver is
// deterministic, role filtering hides what it should (client convenience),
// the palette never reveals restricted destinations, aliases resolve, hash
// deep-link parsing is strict, and shortcut persistence degrades gracefully.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'scoutbox-club', 'package.json'));
const { rolldown } = require('rolldown'); // vite's bundler — TS support built in

let passed = 0;
const fail = (m) => { console.error(`✗ ${m}`); process.exitCode = 1; };
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else fail(m); };
const section = (n) => console.log(`\n— ${n} —`);

// localStorage stub for the shortcut/collapse helpers.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

async function loadNav(app) {
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'sbx-nav-')), 'nav.mjs');
  const bundle = await rolldown({ input: path.join(ROOT, app, 'src', 'nav.ts'), logLevel: 'silent' });
  await bundle.write({ file: out, format: 'esm' });
  await bundle.close();
  return import(pathToFileURL(out).href);
}

const PRO_IDS = ['feed', 'filmroom', 'search', 'shortlist', 'requests', 'messages', 'trials', 'fixtures',
  'ledger', 'funnel', 'reputation', 'plan', 'assessments', 'recruitment', 'planner', 'opportunities',
  'campaigns', 'video', 'outcomes', 'trialdays', 'imports', 'coverage', 'calibration', 'insight',
  'network', 'budgets', 'representation', 'organisation', 'verification'];
const GRASS_IDS = ['feed', 'filmroom', 'search', 'shortlist', 'requests', 'messages', 'trials', 'opendays',
  'squad', 'friendlies', 'fixtures', 'ledger', 'funnel', 'plan', 'assessments', 'recruitment', 'coaches',
  'opportunities', 'campaigns', 'video', 'outcomes', 'trialdays', 'insight', 'coverage', 'calibration',
  'imports', 'network', 'organisation', 'verification'];

const LABELS = {
  'navsec.home': 'Home', 'navsec.discover': 'Discover', 'navsec.recruitment': 'Recruitment',
  'navsec.planning': 'Squad & Planning', 'navsec.team': 'Team', 'navsec.network': 'Network',
  'navsec.organisation': 'Organisation', 'nav.verification': 'Verification', 'nav.trials': 'Trials & Reports',
  'nav.coverage': 'Coverage', 'nav.assessments': 'Assessments', 'nav.messages': 'Inbox',
};
const tr = (k) => LABELS[k] ?? k.replace(/^nav2?\./, '').replace(/^navsec\./, '');

const SCOUT = { role: 'First-Team Scout', verLevel: null };
const LEAD = { role: 'Head of Recruitment', verLevel: null };
const REVIEWER = { role: 'Analyst', verLevel: 'verification_reviewer' };

for (const [app, IDS, expectSections] of [['scoutbox-club', PRO_IDS, 6], ['scoutbox-grassroots', GRASS_IDS, 6]]) {
  const nav = await loadNav(app);
  section(`${app} — configuration integrity`);
  ok(nav.NAV_SECTIONS.length === expectSections, `exactly ${expectSections} primary sections`);
  const mapped = nav.NAV_SECTIONS.flatMap((s) => s.children.map((c) => c.id)).concat([nav.INBOX_ITEM.id]);
  const dupes = mapped.filter((id, i) => mapped.indexOf(id) !== i);
  ok(dupes.length === 0, `no destination appears twice (${dupes.join(',') || 'none'})`);
  const missing = IDS.filter((id) => !mapped.includes(id));
  const extra = mapped.filter((id) => !IDS.includes(id));
  ok(missing.length === 0 && extra.length === 0, `all ${IDS.length} legacy destinations mapped exactly once (missing: ${missing.join(',') || '—'}; extra: ${extra.join(',') || '—'})`);

  section(`${app} — deterministic resolver`);
  for (const id of IDS) {
    const loc = nav.resolveNavigationLocation(id);
    if (id === 'messages') { if (loc.itemId !== 'messages') fail(`inbox resolves (${id})`); else passed++; continue; }
    if (!loc.sectionId || loc.itemId !== id) fail(`resolver maps ${id}`);
    else passed++;
  }
  console.log(`✓ resolver maps every destination (${IDS.length} checks folded)`);
  ok(nav.resolveNavigationLocation('verification').sectionId === 'organisation', 'direct /verification highlights Organisation');
  ok(nav.resolveNavigationLocation('assessments').sectionId === 'recruitment', 'direct /assessments highlights Recruitment');
  const unknown = nav.resolveNavigationLocation('nonexistent');
  ok(unknown.sectionId === null && unknown.itemId === null, 'unknown path highlights nothing');

  section(`${app} — role-aware filtering (client convenience only)`);
  const scoutSections = nav.filterSections(SCOUT);
  ok(!scoutSections.some((s) => s.id === 'organisation'), 'ordinary scout: Organisation absent (no empty category shown)');
  ok(scoutSections.length === expectSections - 1, 'scout sees the compact set');
  ok(nav.filterSections(LEAD).some((s) => s.id === 'organisation'), 'lead role: Organisation present');
  const revOrg = nav.filterSections(REVIEWER).find((s) => s.id === 'organisation');
  ok(!!revOrg && revOrg.children.some((c) => c.id === 'verification'), 'verification authority (non-lead): Organisation → Verification visible');
  if (app === 'scoutbox-club') {
    ok(!revOrg.children.some((c) => c.id === 'budgets'), 'finance stays lead-only even for verification reviewers');
  }

  section(`${app} — command search permission filtering + aliases`);
  ok(nav.searchNav('verification', SCOUT, tr).length === 0, 'restricted destination NEVER appears for a scout');
  ok(nav.searchNav('verify', SCOUT, tr).length === 0, 'aliases cannot bypass the permission filter');
  const leadVer = nav.searchNav('verification', LEAD, tr);
  ok(leadVer.some((r) => r.itemId === 'verification' && r.sectionLabel === 'Organisation'), 'lead search: Organisation → Verification');
  ok(nav.searchNav('trial', LEAD, tr).some((r) => r.itemId === 'trials'), 'alias/prefix: "trial" finds Trials');
  ok(nav.searchNav('coverage', SCOUT, tr).some((r) => r.itemId === 'coverage'), 'scout can find Coverage');
  ok(nav.searchNav('reports', LEAD, tr).some((r) => r.itemId === 'assessments'), 'alias "reports" → Assessments');
  ok(nav.searchNav('inbox', SCOUT, tr).some((r) => r.itemId === 'messages'), 'utility Inbox searchable');

  section(`${app} — hash deep links (strict)`);
  ok(nav.screenFromHash('#/verification') === 'verification', 'valid hash parses');
  ok(nav.screenFromHash('#/nope') === null && nav.screenFromHash('#foo') === null && nav.screenFromHash('') === null, 'unknown/malformed hashes rejected');
  ok(nav.hashForScreen('coverage') === '#/coverage', 'hash round-trip');

  section(`${app} — shortcuts persistence (graceful)`);
  store.clear();
  nav.saveShortcuts('org1', 'u1', ['coverage', 'assessments']);
  ok(nav.loadShortcuts('org1', 'u1', SCOUT).join(',') === 'coverage,assessments', 'pins persist by id');
  nav.saveShortcuts('org1', 'u1', ['verification', 'coverage']);
  ok(nav.loadShortcuts('org1', 'u1', SCOUT).join(',') === 'coverage', 'pin to a now-forbidden destination drops silently (revoked permission)');
  ok(nav.loadShortcuts('org1', 'u1', LEAD).join(',') === 'verification,coverage', 'same pin resolves again for a permitted role');
  store.set('sb-nav-shortcuts:org1:u1', '{not json');
  ok(nav.loadShortcuts('org1', 'u1', SCOUT).length === 0, 'malformed stored shortcuts → empty, no crash');
  store.set('sb-nav-shortcuts:org1:u1', JSON.stringify(['ghost-route', 42, 'search']));
  ok(nav.loadShortcuts('org1', 'u1', SCOUT).join(',') === 'search', 'invalid ids and types filtered out');
  store.set('sb-nav-collapsed', 'garbage');
  ok(nav.loadCollapsed() === false, 'malformed collapsed preference reads as expanded');
}

console.log(`\nnavConfig: ${passed} checks passed${process.exitCode ? ' (WITH FAILURES)' : ''}`);
process.exit(process.exitCode ?? 0);
