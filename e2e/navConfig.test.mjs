// M15-Nav — navigation configuration acceptance (no browser).
// Compiles the REAL nav.ts of Pro and Grassroots with esbuild and asserts:
// every legacy destination is mapped exactly once, the resolver is
// deterministic, role filtering hides what it should (client convenience),
// the palette never reveals restricted destinations, aliases resolve, hash
// deep-link parsing is strict, and shortcut persistence degrades gracefully.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  'network', 'budgets', 'representation', 'organisation', 'verification', 'rooms',
  'secondlook', 'nobodymissed', 'briefs', 'matching', 'watchlists',
  // M20 — the Director Dashboard, inside Recruitment rather than a new section.
  'dashboard'];
const GRASS_IDS = ['feed', 'filmroom', 'search', 'shortlist', 'requests', 'messages', 'trials', 'opendays',
  'squad', 'friendlies', 'fixtures', 'ledger', 'funnel', 'plan', 'assessments', 'recruitment', 'coaches',
  'opportunities', 'campaigns', 'video', 'outcomes', 'trialdays', 'insight', 'coverage', 'calibration',
  'imports', 'network', 'organisation', 'verification', 'rooms',
  'secondlook', 'nobodymissed', 'briefs', 'matching', 'watchlists',
  'dashboard'];

const LABELS = {
  'navsec.home': 'Home', 'navsec.recruitment': 'Recruitment',
  'navsec.planning': 'Squad & Planning', 'navsec.players': 'Players', 'navsec.network': 'Network',
  'navsec.organisation': 'Organisation', 'navsec.club': 'Club', 'nav.verification': 'Verification', 'nav.trials': 'Trials & Reports',
  'nav.coverage': 'Coverage', 'nav.assessments': 'Assessments', 'nav.messages': 'Inbox',
};
const tr = (k) => LABELS[k] ?? k.replace(/^nav2?\./, '').replace(/^navsec\./, '').replace(/^navgrp\./, '').replace(/^navshort\./, '');

const SCOUT = { role: 'First-Team Scout', verLevel: null };
const LEAD = { role: 'Head of Recruitment', verLevel: null };
const REVIEWER = { role: 'Analyst', verLevel: 'verification_reviewer' };

// P2.5: every label key the configuration names must exist in BOTH
// dictionaries of its app — a raw key in the sidebar is a defect, and the
// French half is where one would hide.
function dictionaries(app) {
  const src = readFileSync(path.join(ROOT, app, 'src', 'i18n.ts'), 'utf8');
  const frAt = src.indexOf('\nconst fr');
  const keys = (s) => new Set([...s.matchAll(/'((?:nav|navsec|nav2|navgrp|navshort)\.[A-Za-z0-9_]+)':/g)].map((m) => m[1]));
  return { en: keys(src.slice(0, frAt)), fr: keys(src.slice(frAt)) };
}

// P2.5: five sections in Pro, four in Grassroots. Discover folded into
// Recruitment; Grassroots' Network folded into Club and Team became Players.
for (const [app, IDS, expectSections] of [['scoutbox-club', PRO_IDS, 5], ['scoutbox-grassroots', GRASS_IDS, 4]]) {
  const nav = await loadNav(app);
  section(`${app} — configuration integrity`);
  ok(nav.NAV_SECTIONS.length === expectSections, `exactly ${expectSections} primary sections`);
  const mapped = nav.NAV_SECTIONS.flatMap((s) => s.children.map((c) => c.id)).concat([nav.INBOX_ITEM.id]);
  const dupes = mapped.filter((id, i) => mapped.indexOf(id) !== i);
  ok(dupes.length === 0, `no destination appears twice (${dupes.join(',') || 'none'})`);
  const missing = IDS.filter((id) => !mapped.includes(id));
  const extra = mapped.filter((id) => !IDS.includes(id));
  ok(missing.length === 0 && extra.length === 0, `all ${IDS.length} legacy destinations mapped exactly once (missing: ${missing.join(',') || '—'}; extra: ${extra.join(',') || '—'})`);

  section(`${app} — P2.5 groups: presentation overlay, structurally sound`);
  const problems = nav.validateNavConfig();
  for (const p of problems) console.error(`   ${p}`);
  ok(problems.length === 0, 'every child of a grouped section is in exactly one group, and every group item is a real child');
  const rec = nav.NAV_SECTIONS.find((s) => s.id === 'recruitment');
  ok(!!rec?.groups && rec.groups.length >= 5, `Recruitment is grouped (${rec?.groups?.length ?? 0} groups)`);
  const views = nav.groupedChildren(rec);
  ok(views.every((g) => g.children.length <= 7), `no group has more than 7 pages (max ${Math.max(...views.map((g) => g.children.length))})`);
  ok(views.reduce((n, g) => n + g.children.length, 0) === rec.children.length, 'the grouped view shows every child exactly once');
  const disc = views[0];
  ok(disc.id === 'discover' && disc.children[0].id === 'search', 'Recruitment opens on Discover → Players, so the most-used page is still first');
  // A filtered section keeps its groups, and a group emptied by filtering vanishes.
  const filteredRec = nav.filterSections(SCOUT).find((s) => s.id === 'recruitment');
  ok(nav.groupedChildren(filteredRec).length === views.length, 'groups survive role filtering');
  const fakeSection = { ...rec, children: rec.children.filter((c) => !['dashboard', 'funnel', 'ledger'].includes(c.id)) };
  ok(!nav.groupedChildren(fakeSection).some((g) => g.id === 'analytics'), 'a group with no visible child is not drawn as an empty heading');
  // The phone strip lists one group, never the section.
  const sib = nav.groupSiblings(rec, 'rooms').map((c) => c.id);
  ok(sib.includes('recruitment') && sib.includes('rooms') && !sib.includes('search') && sib.length <= 7, `phone strip for Rooms lists its Pipeline siblings only (${sib.length})`);
  ok(nav.groupOf(rec, 'ledger')?.id === 'analytics', 'the Discovery Ledger lives in Analytics beside the Funnel');
  const home = nav.NAV_SECTIONS.find((s) => s.id === 'home');
  ok(nav.groupedChildren(home).length === 1 && nav.groupedChildren(home)[0].id === null, 'an ungrouped section yields one unlabelled group');
  // Deliberately broken configurations are refused.
  const broken1 = [{ ...rec, groups: [...rec.groups, { id: 'dup', labelKey: 'x', items: ['rooms'] }] }];
  ok(nav.validateNavConfig(broken1).some((p) => /rooms.*2 groups/.test(p)), 'a child in two groups is reported');
  const broken2 = [{ ...rec, groups: rec.groups.map((g, i) => (i === 0 ? { ...g, items: g.items.slice(1) } : g)) }];
  ok(nav.validateNavConfig(broken2).some((p) => /search.*0 groups/.test(p)), 'a child in no group is reported');
  const broken3 = [{ ...rec, groups: [...rec.groups, { id: 'ghost', labelKey: 'x', items: ['not-a-page'] }] }];
  ok(nav.validateNavConfig(broken3).some((p) => /not a child/.test(p)), 'a group item that is not a child is reported');

  section(`${app} — P2.5 closure: phone strip = same pages as the desktop accordion`);
  // The strip is presentation. For every role and every group, the pages it
  // shows (visible + More) must be exactly the pages the desktop accordion
  // shows, in the same order, and no page may be both visible and in More.
  for (const [who, ctx] of [['scout', SCOUT], ['lead', LEAD], ['reviewer', REVIEWER]]) {
    for (const sec of nav.filterSections(ctx)) {
      for (const g of nav.groupedChildren(sec)) {
        for (const child of g.children) {
          const lay = nav.stripLayout(sec, child.id);
          const stripIds = [...lay.visible, ...lay.overflow].map((c) => c.id);
          const deskIds = g.children.map((c) => c.id);
          if (stripIds.slice().sort().join() !== deskIds.slice().sort().join()) fail(`${who} ${sec.id}/${g.id}: strip set ≠ desktop set (${stripIds} vs ${deskIds})`);
          if (lay.visible.some((c) => lay.overflow.includes(c))) fail(`${who} ${sec.id}/${g.id}: a page is both visible and in More`);
          const inVisible = lay.visible.some((c) => c.id === child.id);
          const inMore = !!lay.activeInOverflow && lay.activeInOverflow.id === child.id;
          if (inVisible === inMore) fail(`${who} ${sec.id}/${g.id}/${child.id}: the active page must be marked in exactly one place (visible=${inVisible}, more=${inMore})`);
          if (lay.visible.length > nav.STRIP_MAX_VISIBLE) fail(`${who} ${sec.id}/${g.id}: ${lay.visible.length} visible tabs`);
        }
      }
    }
  }
  ok(true, 'every role, every group: strip pages ≡ accordion pages, active page marked once, ≤ 4 visible tabs');
  // Static width budget: a 360px strip fits about 34 characters of 13px
  // label text plus padding. The live suite measures the real thing (N14);
  // this catches a new long label before a browser does.
  {
    const enDict = readFileSync(path.join(ROOT, app, 'src', 'i18n.ts'), 'utf8');
    const en = (k) => { const m = enDict.match(new RegExp(`'${k.replace('.', '\\.')}': '([^']*)'`)); return m ? m[1] : k; };
    const over = [];
    for (const sec of nav.filterSections(LEAD)) for (const g of nav.groupedChildren(sec)) {
      const lay = nav.stripLayout(sec, g.children[0].id);
      if (lay.visible.length + lay.overflow.length <= 1) continue;
      const base = lay.visible.reduce((n, c) => n + en(c.shortKey ?? c.labelKey).length, 0);
      const chars = base + (lay.overflow.length ? 6 : 0);
      if (chars > 34) over.push(`${sec.id}/${g.id ?? '-'}: ${chars} chars (${lay.visible.map((c) => en(c.shortKey ?? c.labelKey)).join(' · ')}${lay.overflow.length ? ' · More' : ''})`);
      // When a page inside More is current, the control shows that page's name.
      for (const c of lay.overflow) {
        const w = base + en(c.shortKey ?? c.labelKey).length + 1;
        if (w > 34) over.push(`${sec.id}/${g.id ?? '-'} with ${c.id} current: ${w} chars`);
      }
    }
    ok(over.length === 0, `every phone strip fits a 360px row by label budget (${over.join('; ') || 'all ≤ 34 chars'})`);
  }
  const pipe = nav.stripLayout(rec, 'rooms');
  ok(pipe.visible.map((c) => c.id).join() === 'recruitment,rooms,requests', `Pipeline primaries are Cases, Rooms, Requests (${pipe.visible.map((c) => c.id)})`);
  ok(pipe.overflow.length >= 3 && pipe.overflow.every((c) => !c.primary), `Pipeline secondaries sit behind More (${pipe.overflow.map((c) => c.id)})`);
  ok(pipe.activeInOverflow === null && nav.stripLayout(rec, 'campaigns').activeInOverflow?.id === 'campaigns', 'active-state mapping: Rooms is a visible tab, Campaigns is marked on More');
  ok(nav.stripLayout(rec, 'search').overflow.length === 0 && nav.stripLayout(rec, 'search').visible.length === 4, 'a group of four shows whole — no More for Discover');
  ok(nav.stripLayout(rec, 'secondlook').activeInOverflow?.id === 'secondlook' && nav.stripLayout(rec, 'secondlook').visible.map((c) => c.id).join() === 'briefs,matching', 'Intelligence: Briefs and Matching visible; Watchlists, Second Look and Nobody Missed through More (the longer names fit 360px only there)');
  // A scout and a lead see the same Pipeline strip (no role-dependent pages in it).
  const scoutRec = nav.filterSections(SCOUT).find((s) => s.id === 'recruitment');
  ok(JSON.stringify(nav.stripLayout(scoutRec, 'rooms').visible.map((c) => c.id)) === JSON.stringify(pipe.visible.map((c) => c.id)), 'role visibility: the scout strip matches the lead strip for Pipeline');
  ok(tr(rec.children.find((c) => c.id === 'recruitment').labelKey) === 'Cases' || dictionaries(app).en.has('nav2.recruitment'), 'the Cases page no longer shares its name with the Pipeline group');
  for (const c of rec.children) if (c.shortKey && !c.shortKey.startsWith('navshort.')) fail(`${c.id}: short label key must be a navshort.* key`);
  ok(true, 'short strip labels are i18n keys (checked against both dictionaries below)');

  section(`${app} — every navigation label exists in EN and FR`);
  const dict = dictionaries(app);
  const used = new Set(nav.NAV_SECTIONS.flatMap((s) => [s.labelKey, ...s.children.map((c) => c.labelKey), ...s.children.filter((c) => c.shortKey).map((c) => c.shortKey), ...(s.groups ?? []).map((g) => g.labelKey)]).concat([nav.INBOX_ITEM.labelKey]));
  const missEn = [...used].filter((k) => !dict.en.has(k));
  const missFr = [...used].filter((k) => !dict.fr.has(k));
  ok(missEn.length === 0, `EN has every label the configuration names (${used.size} keys; missing: ${missEn.join(',') || '—'})`);
  ok(missFr.length === 0, `FR has every label the configuration names (missing: ${missFr.join(',') || '—'})`);
  for (const k of ['navsec.more', 'navsec.moreAria', 'navsec.moreMenu', 'navsec.toggle', 'navsec.pagesIn', 'navsec.inThisArea', 'navsec.liveOk', 'navsec.liveOff', 'navsec.report', 'navsec.reportAria', 'navsec.orgStatus']) {
    if (!dict.en.has(k) || !dict.fr.has(k)) fail(`shell label ${k} missing in ${dict.en.has(k) ? 'FR' : 'EN'}`); else passed++;
  }
  console.log('✓ the shell\'s own labels (toggle, live state, Report / Block) exist in EN and FR (11 folded)');

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
  ok(nav.resolveNavigationLocation('search').sectionId === 'recruitment', 'P2.5: direct /search highlights Recruitment (Discover is its first group)');
  ok(nav.resolveNavigationLocation('ledger').sectionId === 'recruitment', 'P2.5: direct /ledger highlights Recruitment (Analytics)');
  if (app === 'scoutbox-grassroots') {
    ok(nav.resolveNavigationLocation('squad').sectionId === 'players', 'P2.5: direct /squad highlights Players');
    ok(nav.resolveNavigationLocation('network').sectionId === 'organisation', 'P2.5: direct /network highlights Club');
    ok(nav.resolveNavigationLocation('coverage').sectionId === 'recruitment', 'P2.5: direct /coverage highlights Recruitment (Planning group)');
  }
  const unknown = nav.resolveNavigationLocation('nonexistent');
  ok(unknown.sectionId === null && unknown.itemId === null, 'unknown path highlights nothing');

  section(`${app} — role-aware filtering (client convenience only)`);
  const scoutSections = nav.filterSections(SCOUT);
  if (app === 'scoutbox-club') {
    ok(!scoutSections.some((s) => s.id === 'organisation'), 'ordinary scout: Organisation absent (no empty category shown)');
    ok(scoutSections.length === expectSections - 1, 'scout sees the compact set');
  } else {
    // P2.5: Grassroots' Club holds Clubs & Groups (always visible, exactly as
    // it was under Network) plus the gated admin pages. A non-lead therefore
    // sees Club with ONE child — and nothing that was hidden before.
    const club = scoutSections.find((s) => s.id === 'organisation');
    ok(!!club && club.children.map((c) => c.id).join(',') === 'network', 'ordinary coach: Club shows Clubs & Groups only — no admin page leaks');
    ok(scoutSections.length === expectSections, 'coach sees every section (none is empty)');
  }
  ok(nav.filterSections(LEAD).some((s) => s.id === 'organisation'), 'lead role: Organisation / Club present');
  const revOrg = nav.filterSections(REVIEWER).find((s) => s.id === 'organisation');
  ok(!!revOrg && revOrg.children.some((c) => c.id === 'verification'), 'verification authority (non-lead): Organisation → Verification visible');
  ok(!revOrg.children.some((c) => c.id === 'imports' || c.id === 'plan'), 'integrations and plan stay lead-only even for verification reviewers');
  if (app === 'scoutbox-club') {
    ok(!revOrg.children.some((c) => c.id === 'budgets'), 'finance stays lead-only even for verification reviewers');
  }
  // P2.5: regrouping widened nothing. The set of ids a role can see is the
  // same set it could see before, computed from the same predicates.
  const visibleIds = (ctx) => new Set(nav.filterSections(ctx).flatMap((s) => s.children.map((c) => c.id)));
  const scoutIds = visibleIds(SCOUT), leadIds = visibleIds(LEAD);
  ok(!scoutIds.has('verification') && !scoutIds.has('organisation') && !scoutIds.has('imports') && !scoutIds.has('plan'), 'scout still sees none of the four admin pages');
  ok([...scoutIds].every((id) => leadIds.has(id)), 'everything a scout sees, a lead sees (no inversion)');

  section(`${app} — command search permission filtering + aliases`);
  ok(nav.searchNav('verification', SCOUT, tr).length === 0, 'restricted destination NEVER appears for a scout');
  ok(nav.searchNav('verify', SCOUT, tr).length === 0, 'aliases cannot bypass the permission filter');
  const leadVer = nav.searchNav('verification', LEAD, tr);
  const orgLabel = app === 'scoutbox-club' ? 'Organisation' : 'Club';
  ok(leadVer.some((r) => r.itemId === 'verification' && r.sectionLabel === orgLabel), `lead search: ${orgLabel} → Verification`);
  ok(nav.searchNav('trial', LEAD, tr).some((r) => r.itemId === 'trials'), 'alias/prefix: "trial" finds Trials');
  ok(nav.searchNav('coverage', SCOUT, tr).some((r) => r.itemId === 'coverage'), 'scout can find Coverage');
  ok(nav.searchNav('reports', LEAD, tr).some((r) => r.itemId === 'assessments'), 'alias "reports" → Assessments');
  ok(nav.searchNav('inbox', SCOUT, tr).some((r) => r.itemId === 'messages'), 'utility Inbox searchable');

  section(`${app} — hash deep links (strict)`);
  ok(nav.screenFromHash('#/verification') === 'verification', 'valid hash parses');
  ok(nav.screenFromHash('#/nope') === null && nav.screenFromHash('#foo') === null && nav.screenFromHash('') === null, 'unknown/malformed hashes rejected');
  ok(nav.hashForScreen('coverage') === '#/coverage', 'hash round-trip');
  // M17 — the first parameterised route. It resolves to the Rooms destination
  // and carries the room id; every malformed variant must still reject.
  ok(nav.screenFromHash('#/rooms') === 'rooms', 'Rooms destination has a flat hash');
  ok(nav.screenFromHash('#/recruitment/rooms/case-7') === 'rooms', 'room deep link resolves to the Rooms destination');
  // M18.2: the parent of a deep link the app produces is reachable too.
  ok(nav.screenFromHash('#/recruitment/rooms') === 'rooms', 'the parent of a room deep link resolves to Rooms');
  ok(nav.screenFromHash('#/recruitment/briefs') === 'briefs', 'the parent of a brief deep link resolves to Briefs');
  ok(nav.screenFromHash('#/recruitment/nope') === null && nav.screenFromHash('#/recruitment/rooms/') === null, 'other two-segment hashes stay rejected');
  ok(nav.screenFromHash(nav.hashForScreen('rooms')) === 'rooms' && nav.screenFromHash(nav.hashForScreen('briefs')) === 'briefs', 'every screen hash the app writes, it can read back');
  ok(nav.roomFromHash('#/recruitment/rooms/case-7') === 'case-7', 'room deep link yields the room id');
  ok(nav.roomFromHash('#/rooms') === null && nav.roomFromHash('#/recruitment/rooms/') === null
    && nav.roomFromHash('#/recruitment/rooms/a/b') === null && nav.roomFromHash('#/recruitment/rooms/../x') === null
    && nav.roomFromHash('') === null, 'malformed room deep links rejected');
  ok(nav.hashForRoom('case-7') === '#/recruitment/rooms/case-7', 'room hash round-trip');
  ok(nav.resolveNavigationLocation('rooms').sectionId === 'recruitment', 'Rooms highlights Recruitment');
  // M18 — three more destinations inside Recruitment (still six sections), two
  // named deep links and a second parameterised route, all on the SAME strict
  // mechanism M17 introduced.
  ok(nav.screenFromHash('#/recruitment/second-look') === 'secondlook', 'Second Look deep link resolves');
  ok(nav.screenFromHash('#/recruitment/nobody-missed') === 'nobodymissed', 'Nobody Missed deep link resolves');
  ok(nav.screenFromHash('#/secondlook') === 'secondlook' && nav.screenFromHash('#/briefs') === 'briefs', 'M18 destinations keep a flat hash too');
  ok(nav.hashForScreen('secondlook') === '#/recruitment/second-look'
    && nav.hashForScreen('nobodymissed') === '#/recruitment/nobody-missed', 'M18 named hashes round-trip');
  ok(nav.screenFromHash('#/recruitment/briefs/brf-7') === 'briefs', 'brief deep link resolves to the Briefs destination');

  section(`${app} — M19 deep links`);
  ok(nav.screenFromHash('#/recruitment/matching') === 'matching', 'Player Matching deep link resolves');
  ok(nav.screenFromHash('#/recruitment/watchlists') === 'watchlists', 'the parent of a watchlist deep link resolves to Dynamic Watchlists');
  ok(nav.screenFromHash('#/recruitment/watchlists/wl-7') === 'watchlists', 'watchlist deep link resolves to the Dynamic Watchlists destination');
  ok(nav.watchlistFromHash('#/recruitment/watchlists/wl-7') === 'wl-7', 'the watchlist id is read back out of the hash');
  ok(nav.watchlistFromHash('#/recruitment/watchlists') === null && nav.watchlistFromHash('#/recruitment/watchlists/') === null,
    'a watchlist hash without an id carries no id');
  ok(nav.screenFromHash('#/recruitment/watchlists/') === null && nav.screenFromHash('#/recruitment/matching/') === null,
    'trailing-slash M19 hashes stay rejected');
  ok(nav.screenFromHash('#/matching') === 'matching' && nav.screenFromHash('#/watchlists') === 'watchlists', 'M19 destinations keep a flat hash too');
  ok(nav.hashForScreen('matching') === '#/recruitment/matching' && nav.hashForScreen('watchlists') === '#/recruitment/watchlists', 'M19 named hashes round-trip');
  ok(nav.hashForWatchlist('wl-7') === '#/recruitment/watchlists/wl-7', 'the app writes the watchlist hash it can read back');
  // The criteria payload rides in the hash and is opaque: the client only has
  // to be able to read back what it wrote. The SERVER re-validates every
  // criterion, so a hand-edited link can never widen the candidate set.
  ok(nav.criteriaFromHash('#/recruitment/matching?c=abc123') === 'abc123', 'the criteria state is read back out of a matching link');
  ok(nav.criteriaFromHash('#/recruitment/matching') === null, 'a bare matching link carries no criteria state');
  ok(nav.screenFromHash('#/recruitment/matching?c=abc123') === 'matching', 'a matching link WITH criteria still resolves to the destination');
  ok(nav.screenFromHash('#/recruitment/matching?x=1') === null, 'an unknown query key on a matching link is rejected');
  ok(nav.hashForMatching('abc123') === '#/recruitment/matching?c=abc123' && nav.hashForMatching(null) === '#/recruitment/matching',
    'matching hashes round-trip with and without criteria');
  ok(nav.briefFromHash('#/recruitment/briefs/brf-7') === 'brf-7', 'brief deep link yields the brief id');
  ok(nav.briefFromHash('#/briefs') === null && nav.briefFromHash('#/recruitment/briefs/') === null
    && nav.briefFromHash('#/recruitment/briefs/a/b') === null && nav.briefFromHash('#/recruitment/briefs/../x') === null
    && nav.briefFromHash('') === null, 'malformed brief deep links rejected');
  ok(nav.hashForBrief('brf-7') === '#/recruitment/briefs/brf-7', 'brief hash round-trip');
  ok(nav.briefFromHash('#/recruitment/second-look') === null && nav.roomFromHash('#/recruitment/second-look') === null,
    'a named M18 hash is not mistaken for a parameterised one');
  for (const id of ['secondlook', 'nobodymissed', 'briefs']) {
    ok(nav.resolveNavigationLocation(id).sectionId === 'recruitment', `${id} highlights Recruitment`);
  }

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


// ---------------------------------------------------------------- M23 P5.6B
// ScoutBox Agent: the same nav contract (one source of truth, strict hashes,
// EN/FR labels, convenience-only filtering) on a four-section workspace.
{
  const app = 'scoutbox-agent';
  const AGENT_IDS = ['home', 'profile', 'compliance', 'clients', 'transactions', 'opportunities', 'agency', 'inbox'];
  const nav = await loadNav(app);
  section(`${app} — configuration integrity`);
  ok(nav.NAV_SECTIONS.length === 5, 'exactly 5 primary sections (Home, Clients, Transactions, Opportunities, Agency)');
  const mapped = nav.NAV_SECTIONS.flatMap((s) => s.children.map((c) => c.id)).concat([nav.INBOX_ITEM.id]);
  const dupes = mapped.filter((id, i) => mapped.indexOf(id) !== i);
  ok(dupes.length === 0, `no destination appears twice (${dupes.join(',') || 'none'})`);
  const missing = AGENT_IDS.filter((id) => !mapped.includes(id));
  const extra = mapped.filter((id) => !AGENT_IDS.includes(id));
  ok(missing.length === 0 && extra.length === 0, `all ${AGENT_IDS.length} destinations mapped exactly once (missing: ${missing.join(',') || '—'}; extra: ${extra.join(',') || '—'})`);
  ok(nav.validateNavConfig().length === 0, 'the configuration is structurally sound');
  ok(nav.INBOX_ITEM.id === 'inbox', 'Inbox is the utility destination');
  // P5.6D added Transactions and nothing else: the workspace is a destination,
  // an Offer, a negotiation and a fee workflow are still not.
  ok(mapped.includes('transactions'), 'Transactions is a real destination (P5.6D)');
  ok(!mapped.includes('offers') && !mapped.includes('offer') && !mapped.includes('negotiation') && !mapped.includes('fees') && !mapped.includes('signings'), 'no Offers, Negotiation, Fees or Signings destination exists');
  for (const sec of nav.NAV_SECTIONS) for (const c of sec.children) if (c.shortKey && !c.shortKey.startsWith('navshort.')) fail(`${c.id}: short label key must be a navshort.* key`);

  section(`${app} — every navigation label exists in EN and FR`);
  const dict = dictionaries(app);
  const used = new Set(nav.NAV_SECTIONS.flatMap((s) => [s.labelKey, ...s.children.map((c) => c.labelKey), ...s.children.filter((c) => c.shortKey).map((c) => c.shortKey)]).concat([nav.INBOX_ITEM.labelKey]));
  const missEn = [...used].filter((k) => !dict.en.has(k));
  const missFr = [...used].filter((k) => !dict.fr.has(k));
  ok(missEn.length === 0, `EN has every label the configuration names (${used.size} keys; missing: ${missEn.join(',') || '—'})`);
  ok(missFr.length === 0, `FR has every label the configuration names (missing: ${missFr.join(',') || '—'})`);
  for (const k of ['navsec.more', 'navsec.moreAria', 'navsec.moreMenu', 'navsec.toggle', 'navsec.pagesIn', 'navsec.inThisArea', 'navsec.liveOk', 'navsec.liveOff', 'navsec.report', 'navsec.reportAria', 'navsec.orgStatus']) {
    if (!dict.en.has(k) || !dict.fr.has(k)) fail(`shell label ${k} missing in ${dict.en.has(k) ? 'FR' : 'EN'}`); else passed++;
  }
  console.log('✓ the shell\'s own labels exist in EN and FR (11 folded)');
  {
    const enDict = readFileSync(path.join(ROOT, app, 'src', 'i18n.ts'), 'utf8');
    const en = (k) => { const m = enDict.match(new RegExp(`'${k.replace('.', '\\.')}': '([^']*)'`)); return m ? m[1] : k; };
    const over = [];
    for (const sec of nav.filterSections({ role: 'Agent', tiers: ['licensed_agent', 'agency_admin'] })) for (const g of nav.groupedChildren(sec)) {
      const lay = nav.stripLayout(sec, g.children[0].id);
      if (lay.visible.length + lay.overflow.length <= 1) continue;
      const chars = lay.visible.reduce((n, c) => n + en(c.shortKey ?? c.labelKey).length, 0) + (lay.overflow.length ? 6 : 0);
      if (chars > 34) over.push(`${sec.id}: ${chars} chars`);
    }
    ok(over.length === 0, `every phone strip fits a 360px row by label budget (${over.join('; ') || 'all ≤ 34 chars'})`);
  }

  section(`${app} — deterministic resolver`);
  for (const id of AGENT_IDS) {
    const loc = nav.resolveNavigationLocation(id);
    if (id === 'inbox') { if (loc.itemId !== 'inbox' || loc.sectionId !== null) fail(`inbox resolves (${id})`); else passed++; continue; }
    if (!loc.sectionId || loc.itemId !== id) fail(`resolver maps ${id}`); else passed++;
  }
  console.log(`✓ resolver maps every destination (${AGENT_IDS.length} checks folded)`);
  ok(nav.resolveNavigationLocation('profile').sectionId === 'home', 'direct /profile highlights Home');
  ok(nav.resolveNavigationLocation('compliance').sectionId === 'home', 'direct /compliance highlights Home (P5.6C)');
  ok(nav.resolveNavigationLocation('transactions').sectionId === 'transactions', 'direct /transactions highlights Transactions (P5.6D)');
  ok(nav.resolveNavigationLocation('nonexistent').sectionId === null && nav.resolveNavigationLocation('nonexistent').itemId === null, 'unknown path highlights nothing');

  section(`${app} — role-aware filtering (client convenience only; the server matrix decides)`);
  const LICENSED = { role: 'Agent', tiers: ['licensed_agent'] };
  const ADMIN = { role: 'Director', tiers: ['agency_admin'] };
  const STAFF = { role: 'Analyst', tiers: ['analyst'] };
  const UNKNOWN = { role: 'Agent', tiers: null };
  ok(nav.filterSections(LICENSED).some((s) => s.id === 'opportunities'), 'a licensed agent sees Opportunities');
  ok(!nav.filterSections(ADMIN).some((s) => s.id === 'opportunities') && !nav.filterSections(STAFF).some((s) => s.id === 'opportunities'), 'an administrator or analyst does not (the board reads only through an active relationship)');
  ok(!nav.filterSections(UNKNOWN).some((s) => s.id === 'opportunities'), 'before /me answers, nothing tier-gated is shown (fail closed)');
  ok(['home', 'clients', 'transactions', 'agency'].every((id) => nav.filterSections(STAFF).some((s) => s.id === id)), 'Home, Clients, Transactions and Agency stay visible to every member (their content is server-filtered)');
  ok(nav.filterSections({ role: 'Head of Everything', tiers: ['assistant'] }).length === 4, 'a lead-looking job title changes nothing — only server-reported tiers do');
  ok(!nav.searchNav('opportun', STAFF, tr).some((r) => r.itemId === 'opportunities') && !nav.searchNav('board', STAFF, tr).some((r) => r.itemId === 'opportunities') && !nav.searchNav('trials', STAFF, tr).some((r) => r.itemId === 'opportunities'), 'the palette never reveals Opportunities to a non-agent, by label or alias');
  ok(nav.searchNav('licence', LICENSED, tr).some((r) => r.itemId === 'profile'), 'alias "licence" finds My profile & verification');
  ok(nav.searchNav('team', STAFF, tr).some((r) => r.itemId === 'agency'), 'alias "team" finds Agency');
  ok(nav.searchNav('inbox', STAFF, tr).some((r) => r.itemId === 'inbox'), 'utility Inbox searchable');
  ok(nav.searchNav('offer', LICENSED, tr).length === 0 && nav.searchNav('negotiat', LICENSED, tr).length === 0 && nav.searchNav('fee', LICENSED, tr).length === 0, 'no destination answers to "offer", "negotiat" or "fee"');
  ok(nav.searchNav('transaction', LICENSED, tr).some((r) => r.itemId === 'transactions'), 'the palette finds Transactions for a licensed agent');
  ok(nav.searchNav('transfert', LICENSED, tr).some((r) => r.itemId === 'transactions'), 'and by its French alias');

  section(`${app} — hash deep links (strict)`);
  ok(nav.screenFromHash('#/clients') === 'clients' && nav.screenFromHash('#/agency') === 'agency' && nav.screenFromHash('#/inbox') === 'inbox', 'flat hashes parse');
  ok(nav.screenFromHash('#/nope') === null && nav.screenFromHash('#foo') === null && nav.screenFromHash('') === null && nav.screenFromHash('#/Clients') === null, 'unknown, malformed and wrongly-cased hashes rejected');
  ok(nav.screenFromHash('#/clients/rep-7') === 'clients' && nav.clientFromHash('#/clients/rep-7')?.id === 'rep-7' && nav.clientFromHash('#/clients/rep-7')?.tab === 'overview', 'a client deep link resolves to Clients and carries the id (Overview by default)');
  ok(nav.clientFromHash('#/clients/rep-7/opportunities')?.tab === 'opportunities' && nav.screenFromHash('#/clients/rep-7/activity') === 'clients', 'a client tab deep link carries its tab');
  ok(nav.clientFromHash('#/clients/rep-7/offer') === null && nav.screenFromHash('#/clients/rep-7/offer') === null, 'an unknown client tab (offer) is rejected outright');
  ok(nav.clientFromHash('#/clients/') === null && nav.clientFromHash('#/clients/a/b/c') === null && nav.clientFromHash('#/clients/../x') === null && nav.clientFromHash('') === null, 'malformed client deep links rejected');
  ok(nav.hashForClient('rep-7') === '#/clients/rep-7' && nav.hashForClient('rep-7', 'activity') === '#/clients/rep-7/activity', 'client hashes round-trip');
  ok(nav.screenFromHash('#/agency/team') === 'agency' && nav.agencyTabFromHash('#/agency/team') === 'team' && nav.agencyTabFromHash('#/agency/billing') === null && nav.screenFromHash('#/agency/billing') === null, 'agency tab deep links are strict');
  ok(nav.hashForAgency('overview') === '#/agency' && nav.hashForAgency('settings') === '#/agency/settings', 'agency hashes round-trip');
  // P5.6D transaction deep links. Strict: the id shape is fixed, and a tab the
  // detail screen does not have (offer, signing, fees) is rejected outright, so
  // no hash can conjure a surface that does not exist.
  ok(nav.screenFromHash('#/transactions') === 'transactions' && nav.screenFromHash('#/transactions/atx-7') === 'transactions', 'transaction hashes parse');
  ok(nav.transactionFromHash('#/transactions/atx-7')?.id === 'atx-7' && nav.transactionFromHash('#/transactions/atx-7')?.tab === 'overview', 'a transaction deep link carries the id, Overview by default');
  ok(nav.transactionFromHash('#/transactions/atx-7/compliance')?.tab === 'compliance' && nav.transactionFromHash('#/transactions/atx-7/timeline')?.tab === 'timeline', 'a transaction tab deep link carries its tab');
  ok(nav.transactionFromHash('#/transactions/atx-7/offer') === null && nav.screenFromHash('#/transactions/atx-7/offer') === null, 'an offer tab on a transaction is rejected outright');
  ok(nav.transactionFromHash('#/transactions/atx-7/signing') === null && nav.transactionFromHash('#/transactions/atx-7/fees') === null, 'so are signing and fees');
  ok(nav.transactionFromHash('#/transactions/') === null && nav.transactionFromHash('#/transactions/rep-7') === null && nav.transactionFromHash('#/transactions/../x') === null && nav.transactionFromHash('#/transactions/atx-7/a/b') === null, 'malformed transaction deep links rejected, including a client id in a transaction slot');
  ok(nav.hashForTransaction('atx-7') === '#/transactions/atx-7' && nav.hashForTransaction('atx-7', 'documents') === '#/transactions/atx-7/documents', 'transaction hashes round-trip');
  for (const id of AGENT_IDS) if (nav.screenFromHash(nav.hashForScreen(id)) !== id) fail(`hash round-trip for ${id}`); else passed++;
  console.log('✓ every screen hash the app writes, it can read back (7 folded)');
  ok(nav.screenFromHash('#/compliance/ctx-7') === 'compliance' && nav.contextFromHash('#/compliance/ctx-7') === 'ctx-7', 'a compliance context deep link resolves and carries its id');
  ok(nav.contextFromHash('#/compliance/rep-7') === null && nav.contextFromHash('#/compliance/') === null && nav.contextFromHash('#/compliance/ctx-7/offer') === null && nav.contextFromHash('#/compliance/../x') === null, 'a non-context id, an empty id, an unknown sub-route and traversal are all rejected');
  ok(nav.hashForContext('ctx-7') === '#/compliance/ctx-7', 'context hashes round-trip');
  ok(nav.searchNav('consent', LICENSED, tr).some((r) => r.itemId === 'compliance') && nav.searchNav('conflit', LICENSED, tr).some((r) => r.itemId === 'compliance'), 'aliases "consent" and "conflit" find Conflicts & compliance');

  section(`${app} — shortcuts persistence (graceful)`);
  store.clear();
  nav.saveShortcuts('org1', 'u1', ['clients', 'opportunities']);
  ok(nav.loadShortcuts('org1', 'u1', LICENSED).join(',') === 'clients,opportunities', 'pins persist by id');
  ok(nav.loadShortcuts('org1', 'u1', STAFF).join(',') === 'clients', 'a pin to a now-hidden destination drops silently');
  store.set('sb-agent-shortcuts:org1:u1', '{not json');
  ok(nav.loadShortcuts('org1', 'u1', LICENSED).length === 0, 'malformed stored shortcuts → empty, no crash');
  store.set('sb-agent-shortcuts:org1:u1', JSON.stringify(['ghost', 42, 'agency']));
  ok(nav.loadShortcuts('org1', 'u1', LICENSED).join(',') === 'agency', 'invalid ids and types filtered out');
}

console.log(`\nnavConfig: ${passed} checks passed${process.exitCode ? ' (WITH FAILURES)' : ''}`);
process.exit(process.exitCode ?? 0);
