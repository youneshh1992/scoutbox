// M24F — static visual-quality gates. No browser: the source tree itself is
// the evidence. Run: node m24fVisualAudit.test.mjs (from e2e/).
//
//  1. zero hardcoded product emoji (Unicode Extended_Pictographic) in the
//     five applications' UI source, translations, demo fixtures and the
//     design system — comments stripped, user-generated content untouched;
//  2. Inter remains the UI face: tokens, platform rule, the Player faces;
//     the only other faces are the wordmark (Albert Sans) and the word
//     "Grassroots" (Instrument Serif);
//  3. Grassroots DARK tokens unchanged (tokens.css declares only the
//     workspace green for dark, the light block is the Sage palette);
//  4. no pitch-line / turf background implementation remains;
//  5. the grass photograph is gone (reverted with the Grassroots scheme)
//     unauthenticated entry composition;
//  6. the Agent entry is fixed LIGHT and ignores data-theme;
//  7. the Player bottom navigation has at most five destinations;
//  8. the entry page is still the scroll container (M24E) and every
//     application still carries its exits (M24E).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0; const failures = [];
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else { failures.push(m); console.log(`✗ ${m}`); } };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ------------------------------------------------------------ 1. emoji gate
const PRODUCT_ROOTS = ['scoutbox-club/src', 'scoutbox-grassroots/src', 'scoutbox-agent/src', 'scoutbox-admin/src', 'scoutbox-player/src', 'design-system', 'e2e/launcher.html'];
const SKIP_DIR = /node_modules|screenshots|reference|fonts|assets|dist/;
const PICTO = /\p{Extended_Pictographic}/u;
// Documented exceptions: none. (A future exception must be listed here with its reason.)
const ALLOW = new Set([]);
const stripComments = (s, p) => (/\.css$/.test(p) ? s.replace(/\/\*[\s\S]*?\*\//g, '') : s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1'));
const hits = [];
function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f); const st = fs.statSync(p);
    if (st.isDirectory()) { if (!SKIP_DIR.test(f)) walk(p); }
    else if (/\.(ts|tsx|js|jsx|css|html|json)$/.test(f)) scan(p);
  }
}
function scan(p) {
  stripComments(fs.readFileSync(p, 'utf8'), p).split('\n').forEach((l, i) => {
    for (const m of l.matchAll(new RegExp(PICTO.source, 'gu'))) if (!ALLOW.has(m[0])) hits.push(`${path.relative(ROOT, p)}:${i + 1} ${m[0]} U+${m[0].codePointAt(0).toString(16).toUpperCase()}`);
  });
}
for (const r of PRODUCT_ROOTS) { const p = path.join(ROOT, r); if (fs.statSync(p).isDirectory()) walk(p); else scan(p); }
ok(hits.length === 0, `emoji gate: 0 hardcoded product emoji in UI source (found ${hits.length}${hits.length ? ': ' + hits.slice(0, 5).join(' | ') : ''})`);

// M24F.1 — a pictograph built at runtime (the old profile's country flag was
// String.fromCodePoint over regional-indicator code points) is an emoji the
// literal scan cannot see; forbid the construction in product UI source.
{
  const built = [];
  const scanBuilt = (p) => { const text = fs.readFileSync(p, 'utf8'); if (/fromCodePoint\([^)]*0x1f1[a-f0-9]{2}/i.test(text) || /0x1f1a5|0x1f1e6/i.test(text)) built.push(path.relative(ROOT, p)); };
  const walkBuilt = (d) => { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); if (fs.statSync(q).isDirectory()) { if (!SKIP_DIR.test(f)) walkBuilt(q); } else if (/\.(ts|tsx|js|jsx)$/.test(f)) scanBuilt(q); } };
  for (const r of PRODUCT_ROOTS) { const q = path.join(ROOT, r); if (fs.statSync(q).isDirectory()) walkBuilt(q); }
  ok(built.length === 0, `no product source builds a flag or pictograph from code points (${built.join(', ') || 'none'})`);
}

// ------------------------------------------------------------ 2. Inter
const tokens = read('design-system/tokens.css');
const platform = read('design-system/platform.css');
const fontsCss = read('design-system/fonts.css');
ok(/--sb-font:\s*'Inter'/.test(tokens), 'tokens: --sb-font is Inter');
ok(/html \{ font-family: var\(--sb-font\)/.test(platform), 'platform: html reads --sb-font');
ok(/font-family: 'Inter';[\s\S]*Inter-VariableFont_opsz,wght\.ttf/.test(fontsCss) && /Inter-Italic-VariableFont_opsz,wght\.ttf/.test(fontsCss), 'fonts.css: the two Inter variable faces are bundled');
const familiesInPlatform = [...platform.matchAll(/font-family:\s*([^;]+);/g)].map((m) => m[1].trim());
const foreign = familiesInPlatform.filter((f) => !/var\(--sb-font\)|var\(--sb-font-brand\)|var\(--sb-font-grass|monospace|ui-monospace|SFMono|Menlo|Consolas/.test(f));
ok(foreign.length === 0, `platform.css: every font-family is Inter, the wordmark face, the Grassroots serif or monospace (foreign: ${foreign.join(' | ') || 'none'})`);
ok(!/Arial|Helvetica/.test(platform + tokens + fontsCss), 'no Arial / Helvetica anywhere in the design system');
const playerText = read('scoutbox-player/src/components/Text.tsx');
ok(/Inter-VariableFont_opsz,wght\.ttf/.test(playerText) && /fontFamily: 'Inter'/.test(playerText), 'Player: Text resolves to the bundled Inter');
ok(!fs.existsSync(path.join(ROOT, 'design-system/fonts/InstrumentSerif-OFL.txt')) && !/Instrument Serif/.test(fontsCss) && !/--sb-font-grass/.test(tokens + platform), 'no editorial serif: "Grassroots" is set in Inter like every other word (the M24F serif was reverted at the Founder\'s direction)');

// ------------------------------------------------------------ 3. Grassroots tokens (the M24E scheme, restored)
const grassBlock = tokens.match(/:root\[data-app="grass"\] \{([\s\S]*?)\n\}/);
const darkBlock = tokens.match(/:root\[data-app="grass"\]\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
ok(!!grassBlock && /--sb-workspace: #e5f5e9/.test(grassBlock[1]) && /--grass-line: rgba\(255, 255, 255, 0\.52\)/.test(grassBlock[1]) && /--grass-grain/.test(grassBlock[1]) && /--grass-band/.test(grassBlock[1]), 'Grassroots light: the M24E workspace (#E5F5E9) and its turf tokens — the Sage palette is reverted');
ok(!/--grass-sage|--sb-font-grass|:root\[data-app="grass"\]:not\(\[data-theme="dark"\]\)/.test(tokens), 'Grassroots light: no Sage token and no Sage override block remains');
ok(!!darkBlock && /--sb-workspace: #252e26/.test(darkBlock[1]) && /--grass-line: rgba\(255, 255, 255, 0\.10\)/.test(darkBlock[1]) && darkBlock[1].trim().split('\n').length === 4, 'Grassroots dark: the M24E declarations (workspace green and the three turf tokens) — the shared dark palette is unchanged');
const frozen = JSON.parse(read('e2e/fixtures/m24e-grassroots-dark-tokens.json'));
ok(frozen.tokens['--sb-workspace'] === '#252e26' && frozen.computed.content.bg === 'rgb(37, 46, 38)' && frozen.computed.sidebar.bg === 'rgb(18, 20, 21)', 'the frozen M24E dark values are on file for the live comparison (workspace #252e26, sidebar #121415)');

// ------------------------------------------------------------ 4. the Grassroots turf and pitch (M24E, restored)
ok(/:root\[data-app="grass"\] \.content \{[^}]*--grass-grain/.test(platform) && /:root\[data-app="grass"\] \.content::before \{/.test(platform) && /:root\[data-app="grass"\] \.content::after \{/.test(platform), 'the Grassroots turf grain and pitch markings stand behind the workspace again (M24E)');
ok(/:root\[data-app="grass"\] \.auth-promo \{[^}]*repeating-linear-gradient\(103deg/.test(platform), 'the Grassroots entry introduction carries the blade-of-grass bands again (M24E)');
ok(!/:root\[data-app="grass"\] \.login\.auth-page \{/.test(platform) && !/:root\[data-app="grass"\] \.login\.auth-page::before/.test(platform) && !/:root\[data-app="grass"\] \.brand-sub/.test(platform), 'no M24F Grassroots entry override remains (no Sage page, no hidden pitch, no serif)');
ok(!fs.existsSync(path.join(ROOT, 'scoutbox-player/src/components/PitchBackdrop.tsx')) && !/PitchBackdrop/.test(read('scoutbox-player/src/app/onboarding.tsx')), 'the Player draws no pitch backdrop');

// ------------------------------------------------------------ 5. grass photograph scope
const ASSET = 'grassroots-auth-grass';
const refs = [];
function walkRefs(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f); const st = fs.statSync(p);
    if (st.isDirectory()) { if (!/node_modules|dist|screenshots|\.git/.test(f)) walkRefs(p); }
    else if (/\.(ts|tsx|js|jsx|mjs|css|html|json|md|txt)$/.test(f) && fs.readFileSync(p, 'utf8').includes(ASSET)) refs.push(path.relative(ROOT, p));
  }
}
for (const r of ['scoutbox-club', 'scoutbox-grassroots', 'scoutbox-agent', 'scoutbox-admin', 'scoutbox-player', 'design-system', 'e2e']) walkRefs(path.join(ROOT, r));
const codeRefs = refs.filter((p) => !/\.(md|txt)$/.test(p) && !/^e2e\//.test(p));
ok(codeRefs.length === 0 && !fs.existsSync(path.join(ROOT, 'design-system/assets/grassroots-auth-grass.jpg')), `the grass photograph is gone: no asset on disk and no stylesheet or source reference (${codeRefs.join(', ') || 'none'})`);
ok(!/grassroots-auth-grass/.test(platform + tokens + read('scoutbox-grassroots/src/styles.css')), 'no stylesheet references the photograph');
ok(!/grassroots-auth-grass/.test(read('scoutbox-player/src/app/onboarding.tsx') + read('scoutbox-club/src/App.tsx') + read('scoutbox-agent/src/App.tsx') + read('scoutbox-admin/src/App.tsx')), 'no other application references the photograph');

// ------------------------------------------------------------ 6. Agent entry fixed light
const agentBlock = platform.match(/:root\[data-app="agent"\] \.login\.auth-page \{([\s\S]*?)\n\}/);
ok(!!agentBlock && /--auth-panel: #fdfaf4/.test(agentBlock[1]) && /--auth-promo: #f3eee3/.test(agentBlock[1]) && /--auth-ink: #302d25/.test(agentBlock[1]) && /color-scheme: light/.test(agentBlock[1]), 'Agent entry: the cream light tokens (#FDFAF4 panel, #F3EEE3 introduction, dark ink)');
ok(!/:root\[data-app="agent"\]\[data-theme="dark"\]/.test(platform.split('M24F Agent entry')[1] ?? '') && !/:root\[data-app="agent"\]\[data-theme="dark"\] \.(login|auth-)/.test(platform), 'Agent entry: no entry rule follows the saved dark theme (the dark-theme rules that remain only neutralise the shared dark controls)');
ok(!/:root\[data-app="agent"\] \.login\.auth-page \{[^}]*#202223/.test(platform), 'Agent entry: the dark (#202223) entry scheme is gone');
ok(!/ThemeToggle/.test(read('scoutbox-agent/src/App.tsx').split('function Login')[1]?.split('\n}\n')[0] ?? ''), 'Agent entry: no theme toggle on the entry screen');

// ------------------------------------------------------------ 7. Player bottom navigation ≤ 5
const tabsLayout = read('scoutbox-player/src/app/(tabs)/_layout.tsx');
const tabsConst = tabsLayout.match(/const TABS[^=]*=\s*\[([\s\S]*?)\];/);
const visible = tabsConst ? (tabsConst[1].match(/\{[^}]*\}/g) ?? []).filter((t) => !/hidden: true/.test(t)).length : 99;
ok(visible <= 5 && visible > 0, `Player bottom navigation: ${visible} destinations (≤ 5)`);
ok(!PICTO.test(stripComments(tabsLayout, '_layout.tsx')), 'Player bottom navigation: icons, no emoji');
ok(!/backgroundColor: focused \? colors\.tabActiveBg/.test(tabsLayout), 'Player bottom navigation: no filled tile behind the active destination');

// ------------------------------------------------------------ 8. M24E invariants
ok(/\.login\.auth-page \{[\s\S]*height: 100dvh; overflow-y: auto/.test(platform), 'the entry page is still the scroll container (M24E)');
ok(/\.auth-card \{ margin: auto 0; flex-shrink: 0; \}/.test(platform), 'the entry card still centres by auto margins (M24E)');
for (const [app, file, needle] of [['Pro', 'scoutbox-club/src/App.tsx', 'data-testid="sign-out"'], ['Grassroots', 'scoutbox-grassroots/src/App.tsx', 'data-testid="sign-out"'], ['Agent', 'scoutbox-agent/src/App.tsx', 'data-testid="sign-out"'], ['Trust & Safety', 'scoutbox-admin/src/App.tsx', 'data-testid="sign-out"'], ['Player (You)', 'scoutbox-player/src/app/(tabs)/you.tsx', 'testID="sign-out"'], ['Player (Guardian)', 'scoutbox-player/src/app/guardian.tsx', 'testID="sign-out"']]) {
  ok(read(file).includes(needle), `${app}: Sign out is still there (M24E)`);
}
ok(/data-testid="switch-org"/.test(read('scoutbox-club/src/App.tsx')) && /data-testid="switch-org"/.test(read('scoutbox-grassroots/src/App.tsx')) && /data-testid="switch-org"/.test(read('scoutbox-agent/src/App.tsx')), 'Switch organisation / club / profile are still there (M24E)');
ok(/testID="switch-account"/.test(read('scoutbox-player/src/app/(tabs)/you.tsx')) && /testID="switch-account"/.test(read('scoutbox-player/src/app/guardian.tsx')), 'Player: Switch account is still there (M24E)');

// ------------------------------------------------------------ 9. the metadata casing and the generic-UI rules
ok(/'Verification Pending'/.test(read('scoutbox-grassroots/src/App.tsx')) && /orgTypeLabel\(o\.type\)/.test(read('scoutbox-grassroots/src/App.tsx')), 'Grassroots entry: organisation metadata is title-cased ("Club · Grassroots · Verification Pending")');
ok(/\.auth-form \.org-card:hover \.auth-row-arrow[^}]*transform: translateX\(3px\)/.test(platform) && /\.auth-form \.org-card:hover, \.auth-form \.auth-row:hover \{ filter: none; background: none; \}/.test(platform), 'entry rows: hover is the text and the arrow, never a box');
ok(/\.list-row \{ border-radius: 0; border-bottom: 1px solid var\(--sb-rule\)/.test(platform) && !/\.list-row \{ border-radius: 10px/.test(platform), 'portals: list rows are ruled, not boxed');
ok(/\.notice \{ background: none; border: 0; border-left: 2px solid/.test(platform), 'portals: explanatory notes are a ruled paragraph, not a tinted box');
ok(/\.filters \{[^}]*background: none; border: 0; border-bottom: 1px solid/.test(platform), 'portals: the filter bar is not a card');
ok(/data-testid="coaches-page"/.test(read('scoutbox-grassroots/src/m12screens.tsx')) && /className="ed-record"/.test(read('scoutbox-grassroots/src/m12screens.tsx')), 'Grassroots Coaches: the editorial page (records, not boxes)');
const playerUi = read('scoutbox-player/src/components/ui.tsx');
ok(/section: \{\s*borderTopWidth: 1/.test(playerUi) && /export function ListRow/.test(playerUi) && /export function Disclosure/.test(playerUi), 'Player: Card is a ruled section; ListRow and Disclosure exist');
ok(/testID="home-primary"/.test(read('scoutbox-player/src/app/(tabs)/discover.tsx')) && (read('scoutbox-player/src/app/(tabs)/discover.tsx').match(/<Button primary/g) ?? []).length === 1, 'Player Home: exactly one primary action');

console.log(`\nm24fVisualAudit: ${passed} checks passed${failures.length ? `, ${failures.length} FAILED` : ''}`);
if (failures.length) process.exit(1);
