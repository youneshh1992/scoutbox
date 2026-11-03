# UI design: approved designs and rules

The Founder approved a design for each app (Player on 5 October 2026; Pro, Grassroots and Agent on
6 October 2026) and asked for them to be permanent. This document is the rulebook for those designs.
**The committed implementation is the source of truth**; this describes it so you don't break it.

> Names in brackets, like (BRAND_RULES), are the original documents, removed in the November 2026 cleanup.
> Read one with `git show docs-archive-2026-11:BRAND_RULES.md`. The design system's tokens, `platform.css`,
> AuthShell and CaseNav are documented in [`../design-system/README.md`](../design-system/README.md).

The three rules that matter most:

- The committed implementation is the source of truth. Never rebuild a design from screenshots, generated HTML or old bundles.
- New features must fit the approved design. Redesign only on an explicit Founder request, and never infer one from bug-fix or feature work.
- Work on one app must not restyle other apps, the shared design system or auth screens.


## Shared brand rules

- **Logo.** The logo is permanent: "ScoutBox" in Albert Sans ExtraBold, a green square on the baseline after the "x", and a raised ™ above the square. Never redraw or restyle it. Albert Sans is used for the wordmark only. (BRAND_RULES, M24E_INTER_TYPOGRAPHY)
- **Brand green.** `#00e676` is permanent. Primary actions use `#00e676` with `#113822` text. (BRAND_RULES, design-system/README)
- **™ recipe.**
  - The ™ sits over the square with a 2px optical gap from the "x". It is never a separate "TM" word.
  - Portals: `margin-left: calc(-square - row-gap + 2px)`, 8px in the sidebar and 9px on entry headings.
  - Markup: `<sup class="tm" aria-label="trademark">`.
  - Player: `Wordmark.tsx` stacks the TM (`max(7, round(size×0.3))`) above the square.

  (M24F2_BRAND_WORDMARK)
- **Bundling.** Fonts and assets are bundled and nothing is fetched at runtime. Apple font binaries are never redistributed. (M24E_INTER_TYPOGRAPHY, BRAND_RULES)
- **Icons.** Bundled Phosphor 2.1.1 (MIT). `icon-mapping.json` keeps the call-site names. Portals use Regular. The Player uses duotone and filled. (BRAND_RULES)

## Player (`scoutbox-player`)

Approved 5 October 2026, then made dark-only. Reference captures: `design-system/approved-player-ui/README.md`; portable palette: `design-system/player-theme/`.

- **Dark-only, permanently.**
  - No light mode, OS-following appearance, theme switch or Account › Appearance.
  - Saved light preferences and the OS appearance are ignored on web, iOS and Android.
  - Auth keeps its dark green brand surfaces. Error screens and native/browser chrome are dark.

  (BRAND_RULES)
- **Palette.** Surfaces `#0E131F` and `#161C24`. Controls use a 135° `#00E676`→`#12161A` gradient with a contrast scrim. A carbon canvas with restrained emerald/cyan glows. No looping backgrounds, canvas pitch lines or pastels. The kit is in `design-system/player-theme/`. (BRAND_RULES)
- **Opacity.** Gradient controls run at 70% of their earlier strength: buttons, page tabs, recruitment categories, main/bottom navigation, the Home CTA and message send. The Home hero is .49 and the Home CTA .56. Labels and icons stay fully opaque. (BRAND_RULES)
- **Vivid direction.** Expressive gradients, colourful semantic icons, gradient messaging and animated season charts are accepted. Stats come from records. Identity rings never imply verification or presence. (BRAND_RULES)
- **Typography.** The system font for all text and inputs: SF Pro on Apple, native sans-serif elsewhere. Weights, italics and accessibility scaling are kept. The wordmark stays Albert Sans. (BRAND_RULES)
- **Metadata.**
  - Location comes first, then a bordered position badge on the same row, then a bordered availability pill below.
  - Profile and Football centre this group under the name. Home puts position/location above the name and availability below it beside the joined date.
  - Icons are a map pin, a pitch and a calendar. None of them implies presence or verification.

  (BRAND_RULES)
- **Verification seal.** A bright blue filled seal after the name: 20.9px, a 6px gap, vertically centred, 1px optical offset down. It renders only when `identityVerified` is true. There is no separate "Verified" label. (BRAND_RULES)
- **Home.** The name is weight 700. Goals, assists and matches use ball, boot and pitch icons. Season bars animate once, when visible, and respect reduced motion. (BRAND_RULES)
- **Messaging.** An Instagram-style inbox: search, avatar shortcuts, filter pills, and unboxed one-line rows that open bubble threads. No invented presence or call controls. The icon is a squared bubble with a dash. A raspberry badge overlaps the icon's corner. All / Unread / Requests tabs. Request, Trial (warm gold), Offer and Signing rows always carry their word. A minor's device sees only the guardian outcome line. (BRAND_RULES, M24F3_INBOX_DESIGN)
- **Invitations.** The shared `InvitationCard`: a calendar header, a venue row, labelled details, a response footer and selectable date tiles in the organiser's timezone. (BRAND_RULES)
- **Records.** One outer surface, aligned label/value facts, light separators and a clear action area. Never nested grey panels, boxed notes or dotted metadata paragraphs. Consent is two independent unchecked acknowledgements, with the full text visible before deciding. (BRAND_RULES)
- **Timelines.** The shared TimelineItem/EventRow: a continuous green rail, green points and a 2.8s halo pulse while active (none under reduced motion). The rail ends at the last item. Markers never imply presence, verification or success. (BRAND_RULES)
- **Semantic icons.** Icons match their meaning. The Opportunity board is a board-on-legs. Passport and the CV are a passport with a globe. No default stacked-layers icon. (BRAND_RULES)
- **Goals and reviews.** Goal cards have type icons, due labels and complete/reopen. Completion is a server task count, never a score. Reviews are author-led with an accent rail. Internal club note content is never rendered. (BRAND_RULES)
- **Structural rules still in force.** Five-category nav. No rating or star score of any kind. Journey never shows club-private items (watchlist, shortlist, assessment, rationale, Room discussion, Second Look, private notes). "Joined" comes only from a real `createdAt`. No stock photo for missing media. (M24F_PLAYER_PROFILE_REDESIGN, M24F4_PLAYER_VISUAL_RESET)

## Pro (`scoutbox-club`)

Approved 6 October 2026 as the permanent Pro UI.

- **Palette.** Charcoal and muted pitch-green surfaces, ivory text, square controls and restrained `#00e676`. No workspace theme toggle. Native dark form controls work even for sessions that saved light mode. The final layer is `proFootball.css`, on top of the `proExecutive`, `proRefinements`, `proExperience`, `proCorrespondence` and `proDossier` layers. (PRO_EXECUTIVE)
- **Lockup.** The shared `ProBrand` lockup appears on sign-in and in both nav layouts. The trademark is tucked above the green square, with an aligned outlined Pro badge that has a `#00e676` border and bright lettering. The club access badge matches. (PRO_EXECUTIVE)
- **Entry screen.** Uses `src/assets/pro-stadium.jpg` (original, AI-generated) with a short form and the unchanged login API. "Get access" explains provisioning and never claims public sign-up. (PRO_EXECUTIVE)
- **Navigation.** Six workspace tiles that stay visible while the page index scrolls. A shield club identity. A compact account footer, with status, language and session in settings. (PRO_EXECUTIVE)
- **Toolbar.** A typeable search field, a bell labelled "Alerts" and a separate red report tool. Warnings are dark red with a red edge and light text. (PRO_EXECUTIVE)
- **Messages: the correspondence desk.** A compact log, a narrow inbox, filters, a football context file and a multiline composer (Ctrl/Cmd+Enter sends). Starters fill an editable draft and never auto-send. Never bubble chat. The demo conversation is labelled and isolated. (PRO_EXECUTIVE)
- **Discovery.** Player cards with position markers and comparison. Dossier and list views. CSV export of permitted fields, formula-escaped. A centred dossier with Overview, Footage, Evidence and Club notes tabs. Seal in `#00e676`. (PRO_EXECUTIVE)
- **Film Room.** Timecode, speed, in/out loop, 0.04s steps, J/K/L and I/O shortcuts. Segments use the M12 API (ten-minute limit). Tags never cover the video. (PRO_EXECUTIVE)
- **Analytics.** Bar and table modes, CSV export, rings only for additive categories (never a funnel), suppression kept. Squad Planner and Network show recorded data only, never an invented XI. (PRO_EXECUTIVE)
- **Records.** Criteria are grouped as Required and Preferred. Matching has a two-column editor. Second Look separates the original decision, new evidence, circumstances and confidence. Sentence case throughout. (PRO_EXECUTIVE)

## Grassroots (`scoutbox-grassroots`)

Approved 6 October 2026, plus later authorised refinements.

- **Scope.**
  - Styling applies only to the authenticated workspace, under `:root[data-app="grass"] .grass-workspace`.
  - Stylesheet order: `clubhouse.css` → `scoutDesk.css` → `scoutCharacter.css` → `scoutSuite.css`.
  - Never move this styling into the shared design system, Player or auth.
  - Sign-in/sign-up (`Login`, `AuthShell`, auth styles) stay unchanged.
  - One forest palette regardless of the saved theme. No workspace theme switch.

  (GRASSROOTS_CLUBHOUSE)
- **Palette.** Deep forest and soil surfaces, warm chalk text and muted sage. Green on the main action, active nav, indicators and restrained glows. Warm sand for pending or thin cover. Warnings keep their own colours. (GRASSROOTS_CLUBHOUSE)
- **Entry left panel.** The M24E soft green `--auth-promo` with its blade-and-band texture. The headline "Your club. Your community. Your next player." with one sentence and no bullets. (GRASSROOTS_CLUBHOUSE)
- **Home banner.**
  - Content: the headline, a subtle forest gradient, green accent text and the contextual primary action.
  - Background: faint diagonal turf texture and embossed pitch lines across the whole banner. The banner border is the pitch boundary, with a centre circle, line alpha .10 and 1px strokes. The lines never intercept clicks.
  - Never add an inset perimeter, scenery, a floating or touchline pitch illustration, or the "Built from the ground up" caption.
  - Stacks on narrow screens.

  (GRASSROOTS_CLUBHOUSE)
- **Sidebar.** A compact account panel (29px avatar, about 22% shorter) with role, verification and safeguarding as separate facts, and settings in a disclosure. A flat club nameplate with an initials crest. A left-aligned wordmark and edition lockup (3px gap). (GRASSROOTS_CLUBHOUSE)
- **Toolbar.** Grassroots-only local SVGs: a single-line rounded search field with a green border, a circular outline bell with a green clapper, and a shield safety control. (GRASSROOTS_CLUBHOUSE)
- **Home below the banner.** An attention queue of green rows with a count badge and a Review arrow (zero counts hidden), an activity register filtered by real event types, and club readiness check rows. (GRASSROOTS_CLUBHOUSE)
- **Readable records.** Compact rows and disclosures, never rounded cards around paragraphs or dot-separated facts. Use local `RecordDetails.tsx`. Required and Preferred criteria stay as the server groups them. Discovery is unranked. (GRASSROOTS_CLUBHOUSE)
- **Tools.** Film Room: three panels, session-only labelled markers, tags persisted anonymously, no implied editing or export. Insight: activity, review and evidence views. Integrations: a five-tool workbench. The roster pitch is not a formation. Charts state their scope and keep zeros. Bar/ring only for exclusive groups. Loading and empty states are distinct. (GRASSROOTS_CLUBHOUSE)
- **Sentence case.** `presentation.ts` formats display text only, never enums, IDs, keys or payloads. (GRASSROOTS_CLUBHOUSE)

## Agent (`scoutbox-agent`)

Approved 6 October 2026.

- **Look.** A black/violet business workspace with lavender/pink gradient light and green brand accents, app-local in `agentFinance.css`. Motion is viewport-triggered and respects reduced motion (`AgentExperience.tsx`).
- **Identity.** The wordmark with its close ™ above a spaced violet AGENT line with an aligned accent line. Never the rejected line-art "A" or a Pro badge. (HANDOFF_CLAUDE_AGENT)
- **Toolbar.** An understated search line, a labelled Updates control and a shield report tool. Notifications are an independently scrolling journal.
- **Maps and charts.**
  - Natural Earth I maps (bundled, provenance in `MAP_SOURCE.md`) at uniform scale. Only permitted active clients with a known country appear.
  - Charts show recorded representation activity, not finance. The ring covers active, pending, disputed and expired.
  - Never invent revenue, fees, valuations, reach or signatures.
- **Preserve.** Entry/access, the opportunities deadline board, the team directory with Manage access, aligned licence records, the operating profile with market toggles, the client portfolio (shared records are summary-only and never expose private data), and the profile and compliance tabs.

(AGENT_FINANCE, HANDOFF_CLAUDE_AGENT)

## Admin / Trust & Safety (`scoutbox-admin`)

- No dedicated redesign. It keeps the shared M24A shell: `platform.css`, a 204px sidebar, a 67px top bar, Inter, a light/dark `ThemeToggle` (`sb-theme:safety`) and the ≤900px drawer. (M24A_DESIGN_IMPLEMENTATION, M24E_SCROLLABILITY)
- Codes read as words, with acronyms kept. Trust parameters sit behind "Technical parameters". The not-a-talent-score statement stays. (M24F5_VISUAL_ACCEPTANCE)

## Cross-app UI rules

These apply unless an app's approved design overrides them (see section 3).

- **Emoji.** Zero authored emoji (Unicode Extended_Pictographic) in UI source, translations, fixtures or toasts. Typographic symbols are fine (✓ ✕ → ○ ● ■ ▲ ⌘ ➤). User content is untouched. (M24F_EMOJI_AUDIT)
- **Report control.** Every screen of every app has a Report/Block control (safeguarding). (M24A_DESIGN_IMPLEMENTATION)
- **Navigation limits.** At most five bottom-nav items and at most five tabs or categories per bar (`CASE_NAV_MAX_SUBS = 5`). (M24F4_MINIMAL_PRODUCT_RULES)
- **Portal root density.**
  - One primary line per item, at most one secondary line, and "View details" or a chevron.
  - No root paragraph over 140 characters. Explanation, policy and provenance go behind `Hint`/`About`.
  - **Kept visible:**
    - consent and legal text that must be read before acting;
    - safeguarding statements and errors;
    - governing sentences: the Director Dashboard principle, Nobody Missed "nothing here is ranked", Second Look "does not judge", Matching "no match score", the Rooms never-ranked footer.
  - Pills only for real states: Verified, Pending, Confirmed, Declined, Signed, Trial, Offer, Request, Demo.
  - Navigating rows end in ›, Open, View or Details.
  - One bright primary action per screen.
  - Never "Manage your…", "Here you can…" or "Use this to…".
  - About 70–80% of rows carry no sub-note. Safeguarding copy is relocated, never dropped.

  (M24F3_MINIMALISM_RULES, M24F4_MINIMAL_PRODUCT_RULES, M24F2_SUBNOTE_AUDIT)
- **Truthful data.**
  - Every count, rate and percentage on screen is the server's. The client never derives a score, rank or rate.
  - Withheld figures, empty periods and zeros read differently.
  - Never invent presence, verification or metrics.
  - Trust Score and evidence confidence are not talent. Box Cam is not assessment. "Offer acceptance is not a signature." Nobody Missed is coverage, not ranking.

  (M24F4_MINIMAL_PRODUCT_RULES, M24F5_VISUAL_ACCEPTANCE)
- **Director Dashboard.** Executive root: Period, four KPIs, funnel and stage bars, a coverage ring, Needs attention (five lines at most). Detail sits behind "Show all figures". It never measures a player or colleague. (M24F4_DIRECTOR_DASHBOARD)
- **Time format.** Human only: Now / 2m / Yesterday / Mon / 3 Oct / "3 Oct · 20:45". No seconds, no ISO strings, no `toLocaleString()`. Format through `time.ts` / `design-system/time.ts`. Enum values and slugs are humanised for display only. (M24F3_MINIMALISM_RULES, M24F5_KEPT_SCREEN_REVIEW)
- **Portal typography.** Bundled Inter 4.1 variable through `--sb-font`. Weights: 400 body, 500 nav/meta, 600 labels/buttons, 700 headings, 800 rarely. `code`/`pre` also use Inter. (M24E_INTER_TYPOGRAPHY, M24F5_VISUAL_ACCEPTANCE)
- **Scrollability is a global invariant.** Everything is reachable from 320×568 to 1440×700, including landscape, with no horizontal overflow. The sidebar `.nav-scroll` scrolls on its own, entry pages use `100dvh` with auto overflow, there is a ≤900px drawer, and the Player tab bar never covers content. (M24E_SCROLLABILITY)
- **Accessibility.** A visible focus ring (2px). Reduced motion disables entrance and pulse animation. Active state is never carried by colour or icon alone. (GRASSROOTS_CLUBHOUSE, M24F3_INBOX_DESIGN)
- **Behaviour survives any restyle.** API calls and their arguments, permissions, guardian-mediated contact, provenance, tenant isolation and lifecycle rules. (all app docs)

## Demo artifact build procedure

- Install from the lockfiles (Node 22+). Run `node e2e/buildDemos.mjs`, then `node e2e/demoFreshness.test.mjs`, on committed source.
- Outputs in `e2e/dist/` (Git-ignored):
  - `scoutbox-player-demo.html`
  - `scoutbox-club-demo.html` (Pro)
  - `scoutbox-grassroots-demo.html`
  - `scoutbox-agent-demo.html`
  - `scoutbox-admin-demo.html`
- Each bundle is self-contained, makes no external requests, and carries a build ID and source fingerprint, a sample-data badge, guarded storage and the Player history shim. Serve over HTTP(S), not `file://`.
- **External artifacts.**
  - A source commit or push never updates an external or Claude artifact.
  - Replace the bundle explicitly, open it and verify the displayed build ID.
  - Never reuse an old bundle, paste a fragment or claim a refresh you didn't verify.
  - If the host can't take the full HTML, say so.
- Production builds omit `VITE_DEMO=1` (portals) and `EXPO_PUBLIC_DEMO` (Player). Player CI runs `npx tsc --noEmit -p .` and `npx expo export --platform web`.
- Integrate approved branches through a separate worktree. Never reset away cloud-only or uncommitted work. Approvals never authorized merges, deploys or future pushes.

(AGENTS.md, HANDOFF_CLAUDE_UI, HANDOFF_CLAUDE_AGENT, app docs)

## Founder approvals and instructions

- **2026-10-03.** Grassroots entry: no grass photograph and no centre-circle motif. Restore the M24E green panel. The Instrument Serif "Grassroots" and the Sage palette were reverted. (M24F2_DEFECT_REGISTER, design-system/README)
- **2026-10-04.** "Explore is good": the Player board and fit were kept. (M24F5_KEPT_SCREEN_REVIEW)
- **2026-10-04 (M24F.5.1).** Asked for a real grass photo on the Grassroots auth panel only. Never supplied or approved. (GRASSROOTS_CLUBHOUSE)
- **2026-10-05.** The logo and `#00e676` are permanent, and the Player palette and screens may be redesigned. (BRAND_RULES)
- **2026-10-05.** The vivid Player was approved: "OH YES APPLY THIS IMMEDIATELY NOW WE ARE TALKING". (BRAND_RULES)
- **2026-10-05.** Phosphor icons. The Instagram inbox reference. SF Pro, not New York, for the Player. (BRAND_RULES)
- **2026-10-05.** The complete Player design was approved as permanent. Then: "Get rid of light mode. Dark is PERFECT and will remain the main theme." (BRAND_RULES)
- **2026-10-05.** The Grassroots makeover gets full creative control except the logo and colours. Auth stays as it is. (CLAUDE_old)
- **2026-10-06, Grassroots.** Rejected generic mastheads, sentence-packed and dot-separated records, and both pitch illustrations. Asked for a traditional search bar and bell, a smaller account panel and a subtle full-banner embossed pitch. Final approval as the artifact UI. (GRASSROOTS_CLUBHOUSE)
- **2026-10-06, Pro.** Asked for a luxury flagship distinct from Grassroots with a football identity and a new entry screen. Rejected bubble chat. Final approval as the permanent baseline. (PRO_EXECUTIVE)
- **2026-10-06, Agent.** Approved with "This is good to go and ready to push for github and ready for claude to use as an artifact". (AGENT_FINANCE)

## What the approvals replaced (don't bring these back)

Older docs, tests and screenshots describe these earlier designs. They are history, not grounds to revert. (Behavioural tests must still not be silently removed.)

### Player

- **Theme.** Light mode, OS appearance and the theme switch were replaced by dark-only. The "High-Voltage Cyber" light palette, the light Home sun colour and the light captures are dead.
- **Font.** Inter on every screen (M24E/M24F.4: "-apple-system never primary") was replaced by the system font. The M24A Albert Sans text was replaced earlier. Inter remains for the portals.
- **Minimalism.** The M24F–F.4 Player word budgets, flat surfaces, "one data colour, no rainbow" and the restrained proposal were replaced by the vivid approved design. The old M24 minimalism live suites are historical and are not grounds to revert, though behavioural tests must not be silently removed.
- **Metadata and seal.** Metadata went from vertical unboxed, to restored bordered badges, to location first. The seal went from 22px to 20.9px. Control opacity went from light-only to 70% in both themes.
- **Canvas.** The emerald/cyan/violet/magenta canvas and purple/pink pastels were removed in favour of Midnight Stealth.

### Grassroots

- The M24A/E mint (`#e5f5e9`) and dark (`#252e26`) schemes and the M24F flat light workspace were replaced by the forest Clubhouse.
- `scoutCharacter` mastheads and ruled headings were replaced by `scoutSuite`.
- Pitch illustrations and `ClubGround.tsx` were replaced by the simple embossed banner.
- The Finder and Updates tiles were replaced by a traditional search bar and bell.
- The gold-flag attention row was replaced by green rows.
- The rounded club container was replaced by a flat nameplate.

### Agent and Pro

- **Agent.** The M24A cream palette with the gold `#a67c2e` label was replaced by black/violet.
- **Pro.** The M24A light shell was replaced by charcoal. The blue-slate layer gave way to `proFootball.css`, and bubble chat to the correspondence desk.

### Shared

- The 🔒 private-note glyph (kept in M24D) was removed by the M24F zero-emoji rule.

### ⚠ Contradictions resolved in the November 2026 cleanup

- **Stock images vs the Pro entry photo.** M24F.4's "no stock images" conflicts with the approved AI-generated stadium photo on the Pro entry. I picked the Pro image, because the later app-specific approval wins. "No fake photo for missing media" still holds.
- **Grassroots editorial face.** M24F5 reports mention a "Grassroots editorial face", but the README says the serif was reverted. ✗ There is no Instrument Serif in `scoutbox-grassroots/src`, so I picked "reverted".
- **Player green.** M24F_PLAYER_PROFILE_REDESIGN cites `#33EE7C`. ✓ The code uses `#00e676`.
- **Trial accent.** M24F3_INBOX_DESIGN gives the dark trial accent as `#e9c46a`. ≠ The code has `trial: '#f6c376'`. I picked the code.
- **Stale design-system README.** `design-system/README.md` (which is staying) is stale. It says:
  - the Player uses Inter;
  - every app, including the Player, has a theme switch;
  - Grassroots uses mint and dark palettes, and Agent the cream palette;
  - the icon set is lucide.

  The code and the approvals win. Its portal Inter, tokens, `platform.css`, AuthShell, CaseNav, sub-note and one-line sections are still accurate. Don't duplicate them, but correct the stale lines.

## Open questions and deferred work

- **Grassroots auth photo.** Approve the historical CC0 `design-system/assets/grassroots-auth-grass.jpg` (in git history only) or supply the intended photo. Then test the scope and test at 390/430/768/1024/1440. (GRASSROOTS_CLUBHOUSE)
- **Native Player.** Native iOS/Android rendering of the approved Player is unverified: fonts, icons, dark-only persistence and the seal. All checks ran on the web export. (HANDOFF_CLAUDE_UI)
- **Portal coverage.** The redesigned portals were checked in demo-data audits only. Not every role/state permutation or backend empty and error state was exercised. (app docs)
- **Trust & Safety.** No design pass yet. Its review queue still has equal-weight Approve/Reject/Escalate buttons and dense copy. (M24D_VISUAL_PERSONALITY_AUDIT)
- **Design-system README.** `design-system/README.md` now opens with a note listing what the approvals superseded. Its body still describes the M24A baseline, so rewrite it properly if that confuses anyone.

## Also worth knowing

- `design-system/player-theme/`: CSS, Tailwind v3/v4 and USAGE. The portable form of the approved dark Player palette. Keep it.
- `M24F4_DIRECTOR_DASHBOARD.md` §2 maps each dashboard figure to its server payload field. Worth a code comment if the dashboard changes.

## Where the code implements it

*Spot-checked on 3 November 2026.*

- ✓ Dark-only, `#00e676`, `#0e131f`/`#161c24`/`#12161a`: `scoutbox-player/src/theme.ts:1-18`.
- ✓ System font: `scoutbox-player/src/components/Text.tsx:12-13`.
- ✓ Seal 20.9px, offset 1px, `#0088ff`: `components/PlayerIdentity.tsx:25`.
- ✓ Hero .49 and CTA .8 × control .7 = .56: `app/(tabs)/discover.tsx:121,137`, `components/Vivid.tsx:16`.
- ✓ Grassroots CSS order and scoping: `scoutbox-grassroots/src/main.tsx:5-8`.
- ✓ The Pro (`proFootball.css`, `ProBrand`), Agent (`agentFinance.css`) and Admin theme-toggle (`scoutbox-admin/src/App.tsx:161`) layers exist.
- ✓ The five outputs: `e2e/buildDemos.mjs:20-34`.
