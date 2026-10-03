// M24F.2 — static density / categorisation / brand gates. No browser: the
// source tree is the evidence. Run from e2e/: node m24f2DensityAudit.test.mjs
//
//  1. Player › Clubs and › Account are ≤ 5 categories each, with the four
//     agreed names, and Suitability preferences live under Account › Preferences;
//  2. the Grassroots entry introduction has NO diagonal gradient; the
//     centre-circle / halfway-line motif over the photograph is declared in
//     the Grassroots stylesheet only; the photograph is referenced nowhere else;
//  3. the Agent active-navigation tokens are gold in both themes;
//  4. the M24F.1 profile keeps its four sections;
//  5. Sign out is present in every application;
//  6. the ™ recipe: raised over the square, 2 px optical gap, no old gap;
//     the Player Wordmark stacks TM over the square;
//  7. no generic helper opener in the five applications' UI source.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0; const failures = [];
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else { failures.push(m); console.log(`✗ ${m}`); } };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ------------------------------------------------------------ 1. Player categories
const you = read('scoutbox-player/src/app/(tabs)/you.tsx');
const cats = (name) => { const m = you.match(new RegExp(`const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\];`)); return m ? [...m[1].matchAll(/key: '([a-z]+)'/g)].map((x) => x[1]) : []; };
const clubs = cats('CLUBS'); const account = cats('ACCOUNT');
ok(clubs.length > 0 && clubs.length <= 5 && clubs.join(',') === 'current,requests,development,history', `Player › Clubs: ${clubs.length} categories (≤ 5): ${clubs.join(' / ')}`);
ok(account.length > 0 && account.length <= 5 && account.join(',') === 'profile,privacy,preferences,appearance', `Player › Account: ${account.length} categories (≤ 5): ${account.join(' / ')}`);
ok(/params\.section/.test(you) && /router\.setParams\(\{ tab: k, section: '' \}\)/.test(you) && /window\.history\.pushState\(/.test(you) && /remember\(tab, k\)/.test(you), 'Player: the section is derived from ?section=, cleared when the tab changes, and every change is a history entry (no server-side UI state)');
const clubsSections = read('scoutbox-player/src/components/ClubsSections.tsx');
ok(!/PreferencesSection/.test(clubsSections) && /accountSection === 'preferences' && \([\s\S]{0,200}<PreferencesSection/.test(you), 'Suitability preferences render under Account › Preferences, not under Clubs');
ok(/testID=\{`clubs-dev-details-/.test(clubsSections) && /pt\('clubsViewDetails'\)/.test(clubsSections), 'Clubs › Development: the full feedback and the objective controls sit behind "View details"');
ok(/testID=\{`account-cat-\$\{c\.key\}`\}|testID="account-cat-/.test(you) && !/<ListRow[^>]*testID=\{`account-cat-[^>]*value=/.test(you), 'Account root: four plain rows, no sub-note on a category row');
ok(/testID="account-back"/.test(you) && /chevron-left/.test(you), 'Account category pages: a back control');

// ------------------------------------------------------------ 2. Grassroots entry
const platform = read('design-system/platform.css');
const grassCss = read('scoutbox-grassroots/src/styles.css');
const grassPromo = [...platform.matchAll(/:root\[data-app="grass"\] \.auth-promo \{([^}]*)\}/g)].map((m) => m[1]).join(' ');
ok(grassPromo.length > 0 && !/repeating-linear-gradient|linear-gradient\(\s*\d+deg/.test(grassPromo), 'Grassroots entry: no diagonal gradient on the introduction in platform.css');
const promoRule = grassCss.match(/:root\[data-app="grass"\] \.auth-promo \{([^}]*)\}/);
ok(!!promoRule && /radial-gradient\(circle at 50% 52%/.test(promoRule[1]) && /grassroots-auth-grass\.jpg/.test(promoRule[1]) && !/repeating-linear-gradient|\d+deg/.test(promoRule[1].replace(/180deg/, '')), 'Grassroots entry: the centre-circle motif over the photograph, no diagonal, in the Grassroots stylesheet');
ok(!/grassroots-auth-grass/.test(platform + read('design-system/tokens.css') + read('scoutbox-club/src/styles.css') + read('scoutbox-agent/src/styles.css') + read('scoutbox-admin/src/styles.css')), 'the grass photograph is referenced by no other stylesheet');
ok(!/\.content[^{]*\{[^}]*grassroots-auth-grass/.test(grassCss) && !/data-theme/.test(promoRule?.[0] ?? ''), 'the photograph never reaches an authenticated surface');
const grassApp = read('scoutbox-grassroots/src/App.tsx');
ok(/points=\{\[\]\}/.test(grassApp) && !/Adults are visible at once|No unsolicited contact|Self-contained demo/.test(grassApp) && /className="auth-env"/.test(grassApp), 'Grassroots entry: no bullet points, no demo marketing note; "Demo environment" as a quiet indicator');
ok(/points\.length \? \(/.test(read('design-system/AuthShell.tsx')), 'AuthShell renders no list for an empty points array');
ok(/:root\[data-app="grass"\]\[data-theme="dark"\] \.content::before \{/.test(platform) && !/:root\[data-app="grass"\] \.content::before \{/.test(platform), 'Grassroots: pitch markings are dark-only; the light workspace is plain');
ok(/:root\[data-app="grass"\]:not\(\[data-theme="dark"\]\) \.sidebar \{[^}]*--sb-urgent-ink: #ffb4a8/.test(platform), 'Grassroots light sidebar: Sign out keeps a readable red on navy');

// ------------------------------------------------------------ 3. Agent gold
const tokens = read('design-system/tokens.css');
const agentLight = tokens.match(/:root\[data-app="agent"\]:not\(\[data-theme="dark"\]\) \{([\s\S]*?)\n\}/);
const agentDark = tokens.match(/:root\[data-app="agent"\]\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
ok(!!agentLight && /--sb-nav-active-bg: #f7f1e3/.test(agentLight[1]) && /--sb-nav-active-fg: #7a5a1c/.test(agentLight[1]) && /--sb-nav-active-icon: #a67c2e/.test(agentLight[1]), 'Agent light: active navigation tokens are gold (#F7F1E3 / #7A5A1C / #A67C2E)');
ok(!!agentDark && /--sb-nav-active-bg: rgba\(199, 169, 107, 0?\.14\)/.test(agentDark[1]) && /--sb-nav-active-fg: #d0b57b/.test(agentDark[1]) && /--sb-nav-active-icon: #c7a96b/.test(agentDark[1]), 'Agent dark: active navigation tokens are gold (#D0B57B / #C7A96B)');
ok(!/--sb-nav-active-(bg|fg|icon): #00e676|--sb-nav-active-(bg|fg|icon): #33ee7c/.test((agentLight?.[1] ?? '') + (agentDark?.[1] ?? '')), 'Agent: no green in the active navigation tokens');
ok(/:root\[data-app="agent"\] \.sidebar button\.active[^{]*\{[^}]*var\(--sb-nav-active-fg\)/.test(platform) && /inset 3px 0 0/.test(platform.split('Agent')[1] ?? platform), 'Agent: the active destination reads the gold tokens and carries an inset bar (not colour-only)');

// ------------------------------------------------------------ 4. the M24F.1 profile
const profile = read('scoutbox-player/src/app/(tabs)/profile.tsx');
const sections = [...(profile.match(/const SECTION_KEYS[^=]*=\s*\[([\s\S]*?)\];/)?.[1].matchAll(/'([a-z]+)'/g) ?? [])].map((m) => m[1]);
ok(sections.join(',') === 'overview,performance,evidence,journey', `Profile: the four M24F.1 sections intact (${sections.join(' / ')})`);
ok(/testID="profile-next"/.test(profile) && /testID="profile-header"/.test(profile), 'Profile: the identity header and the one current action remain');

// ------------------------------------------------------------ 5. exits
for (const [app, file, needle] of [['Pro', 'scoutbox-club/src/App.tsx', 'data-testid="sign-out"'], ['Grassroots', 'scoutbox-grassroots/src/App.tsx', 'data-testid="sign-out"'], ['Agent', 'scoutbox-agent/src/App.tsx', 'data-testid="sign-out"'], ['Trust & Safety', 'scoutbox-admin/src/App.tsx', 'data-testid="sign-out"'], ['Player (You)', 'scoutbox-player/src/app/(tabs)/you.tsx', 'testID="sign-out"'], ['Player (Guardian)', 'scoutbox-player/src/app/guardian.tsx', 'testID="sign-out"']]) {
  ok(read(file).includes(needle), `${app}: Sign out is present`);
}
ok(/testID="switch-account"/.test(you) && you.indexOf('testID="switch-account"') < you.indexOf('testID="sign-out"'), 'Player › Account: Switch account and Sign out sit beneath the category list');

// ------------------------------------------------------------ 6. the ™
const tmRule = platform.match(/\.brand \.tm, \.login h1 \.tm \{([^}]*)\}/);
ok(!!tmRule && /font-size: 8px/.test(tmRule[1]) && /align-self: flex-start/.test(tmRule[1]) && /margin: 0 0 0 calc\(-6px - 7px \+ 2px\)/.test(tmRule[1]), 'portals: the ™ is 8px, raised, pulled back over the square with a 2px optical gap');
ok(/\.login h1 \.tm \{[^}]*margin-left: calc\(-8px - 7px \+ 2px\)/.test(platform) && /\.auth-form h1 \.tm \{[^}]*margin-left: calc\(-8px - 7px \+ 2px\)/.test(platform), 'portals: the entry headings use the same recipe at their 8px square');
ok(!/\.tm \{[^}]*margin-left: (4|6|8)px/.test(platform) && !/\.tm \{[^}]*margin: 0 0 0 (4|6|8)px/.test(platform), 'portals: no rule re-introduces the old gap after the square');
ok(/aria-label="trademark"/.test(read('design-system/AuthShell.tsx')) && /aria-label="trademark"/.test(platform.length ? read('scoutbox-club/src/navui.tsx') : ''), 'portals: the ™ is announced as "trademark"');
const wordmark = read('scoutbox-player/src/components/Wordmark.tsx');
ok(/testID="wordmark-mark"/.test(wordmark) && /accessibilityLabel="trademark"/.test(wordmark) && /marginLeft: 2/.test(wordmark) && /alignItems: 'flex-end'/.test(wordmark), 'Player: the Wordmark stacks the TM over the square, 2px after the word, on the baseline');

// ------------------------------------------------------------ 7. generic helper openers
const GENERIC = /\b(Manage your|Here you can|Use this to|Control how|Choose whether)\b/;
const hits = [];
const SKIP = /node_modules|screenshots|reference|fonts|assets|dist|\.test\./;
function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f); const st = fs.statSync(p);
    if (st.isDirectory()) { if (!SKIP.test(f)) walk(p); }
    else if (/\.(ts|tsx)$/.test(f) && !SKIP.test(f)) {
      fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1').split('\n').forEach((l, i) => { if (GENERIC.test(l)) hits.push(`${path.relative(ROOT, p)}:${i + 1}`); });
    }
  }
}
for (const r of ['scoutbox-club/src', 'scoutbox-grassroots/src', 'scoutbox-agent/src', 'scoutbox-admin/src', 'scoutbox-player/src', 'design-system']) walk(path.join(ROOT, r));
ok(hits.length === 0, `no "Manage your… / Here you can… / Use this to… / Control how… / Choose whether…" in the five applications (${hits.slice(0, 4).join(', ') || 'none'})`);
ok(/Supporting copy is exceptional, not default/.test(read('design-system/README.md')), 'the design system states the rule');

// ------------------------------------------------------------ 8. the Grassroots Home
const home = read('scoutbox-grassroots/src/homeScreen.tsx');
ok(/testID="home-welcome"|data-testid="home-welcome"/.test(home) && /data-testid="home-primary"/.test(home) && /data-testid="home-summary"/.test(home) && /data-testid="home-progress"/.test(home) && /data-testid="home-activity"/.test(home) && /data-testid="home-quick"/.test(home), 'Grassroots Home: welcome, one primary, summary, progress, activity, quick actions');
ok((home.match(/className="primary"/g) ?? []).length === 1 && !/%/.test(home.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'Grassroots Home: exactly one primary action and no invented percentage');
ok(/<HomeScreen/.test(grassApp) && !/<FeedScreen/.test(grassApp), 'Grassroots: the Home replaces the bare feed');

console.log(`\nm24f2DensityAudit: ${passed} checks passed${failures.length ? `, ${failures.length} FAILED` : ''}`);
if (failures.length) process.exit(1);
