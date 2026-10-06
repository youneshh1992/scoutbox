# Grassroots Clubhouse design

Implemented for the Founder's 5 October 2026 request for a complete Grassroots desktop makeover: an earthy football feel with gradients and glows, led by ScoutBox green. This is the new implementation for review; it is not a claim of subsequent visual approval.

## Scope and source

The authenticated Grassroots workspace owns this presentation. Its stylesheets are `scoutbox-grassroots/src/clubhouse.css` and `scoutbox-grassroots/src/scoutDesk.css`, loaded in that order after the shared base styles. Every rule is scoped below `:root[data-app="grass"] .grass-workspace`. The exact logo and brand green `#00e676` remain intact. Player, Pro, Agent, Admin and the shared design system are not restyled.

Sign-in and sign-up are explicitly excluded. Keep `Login`, `AuthShell` and auth styles unchanged. The existing appearance hook remains for entry-page compatibility; the signed-in workspace uses a single forest palette independent of saved light/dark preferences. There is no workspace theme switch.

This request supersedes old M24F Grassroots requirements for flat surfaces, no gradients and the old light workspace. It does not supersede permissions, safeguarding, privacy or recruitment state rules.

## Visual direction

- Deep forest and soil-toned surfaces, warm chalk text and muted sage secondary text.
- ScoutBox green on the main action, active navigation, key indicators, pitch edges and restrained glows. Warm sand distinguishes pending or thin-cover states; warnings retain separate colours and text.
- Home as a clubhouse: welcome, one real next action, decorative ground illustration, live endpoint counts, attention, activity, club progress and quick actions.
- Player discovery is a scouting register: position, identity/location, football facts, availability/contract, evidence coverage and comparison controls. Identity icons appear only for records with identityVerified. It never ranks by evidence confidence or ability.
- Consistent panels, record spacing, form fields, squad rows, profile drawers and conversations throughout the workspace. Desktop remains the primary layout; smaller windows use the existing navigation drawer and stacked content.
- The ground SVG is decorative, not a map, formation or live squad view. No fabricated metrics, online states, badges or match data.
- Keyboard focus stays visible; reduced-motion users receive no entrance animation.

## Behaviour

Keep existing API calls, navigation permissions, data provenance, guardian-mediated contact, disclosure text and state transitions. Account switching, search, filters, comparison, notes, invitations, reports and recruitment actions retain their handlers. All stats and percentages continue to come from existing records.

## Validation

TypeScript and the production Vite build pass. Existing navigation, case navigation and icon parity checks pass. A source comparison confirms the Login component is byte-for-byte unchanged and the 151 API calls in the four edited interaction files are unchanged. The shared logo/auth/theme files and other applications have no source changes.

Browser review covers Home, player discovery and profile drawer, Squad & Match Days, Coaches, Clubs & Groups, Open Days, Messages, command search and narrow Home/discovery layouts. Demo data is sample data, not a connected production backend.

For a refreshed self-contained demo, run the canonical `node e2e/buildDemos.mjs` with the repository's runtime, then `node e2e/demoFreshness.test.mjs`. Use the resulting Grassroots bundle over HTTP. A local commit or bundle does not update Claude's published artifact automatically. Do not push, merge or deploy without the Founder's authorization for that action.

## Scout workspace refinement — 5 October 2026

The Founder liked the earthy base and requested a more professional scouting presentation across the entire authenticated app. Keep the clubhouse hero, exact logo and brand palette; carry the following approach into future additions:

- Home below the summary uses a compact attention queue, filterable activity register, club readiness and workspace tools. Filters use actual event types and counts.
- Replace repeated rounded cards and long unstructured summaries with clear headings, compact record rows, metric strips and accessible disclosures. Keep warning, privacy and provenance copy readable.
- Player discovery uses labelled columns with a separate comparison control. Search, filters, saved searches, comparison and profile actions retain their original handlers.
- Film Room is a desktop footage review station with player information and observation controls beside the video, stacking at narrow widths. It is not a social feed.
- Player dossiers use labelled football facts, ruled sections, operational action groups and consistently styled Passport, Training, Combine, Trust and Development content. Goals, actions and reviews are distinct records, with factual completion counts, never a player development score.
- Fixtures use date, match/venue and participation columns. Second Look distinguishes the original decision from evidence changes and retains unresolved club-side reasons. Outcome records separate the player, check-in milestone and due date.
- The new refinement stylesheet is scoped to the Grassroots workspace. Do not move it into the shared design system or apply it to Player/authentication.

### Refinement validation scope

Browser review covered all 36 navigation destinations at 1440px: Home, Squad & Match Days, Coaches, Friendlies, Fixtures, Players, Shortlist, Film Room, Scouting Insight, Cases, Recruitment Rooms, Player Requests, Opportunities, Campaigns, Open Days, Signings & Outcomes, Assessments, Evidence & Video, Trials & Reports, Trial Days, Recruitment Briefs, Player Matching, Dynamic Watchlists, Second Look, Nobody Missed, Director Dashboard, Funnel, Discovery Ledger, Coverage, Calibration, Clubs & Groups, Staff & Security, Verification, Integrations, Plan & Compliance and Messages.

Deeper review covered all 20 recruitment-room panels, player dossier/Passport/Box Training/Combine/Trust/Development, comparison, Second Look review changes, the nine Staff & Security disclosures, verification tabs and the notification popover. Home filters and two-player comparison were exercised. Home, Players, Squad, Film Room, Rooms, Matching and Verification were checked at 900px and 390px with no document-level horizontal overflow. This is a demo-data visual and navigation audit, not a claim that every permission, backend, empty or error state was exercised.

TypeScript, production build, navigation/case-navigation/icon checks and API-call preservation checks pass. Login remains byte-for-byte unchanged; no shared design-system or other app source changes. Build the canonical demos and run the freshness check after committing so the preview identifies the actual saved source.

## Visual scouting tools — 6 October 2026

The Founder requested stronger character across Squad & Match Days, Coaches,
Friendlies, Fixtures, Recruitment, Clubs & Groups, Staff & Security and
Verification, including animations and truthful data visualisations.

`scoutCharacter.css` now follows `scoutDesk.css`, scoped to the authenticated
Grassroots workspace. Preserve the compact sidebar identity panel: personal
role, organisation verification and safeguarding are separate facts. Language,
club switching and sign-out live in the accessible Account settings disclosure.

Use the green-edged page mastheads and semantic icons, forest work surfaces,
clear section rules and restrained glow. Position coverage uses a pitch diagram
of actual roster counts, explicitly not a formation. Fixture participation uses
columns. Recruitment, coaching, evidence, clubs and setup use labelled count
charts; mutually exclusive groups can switch between bars and a ring. Counts
must come from the existing returned records, with the scope stated beside the
chart. Repeated players across fixtures and clubs across groups are not unique
population totals. Never invent performance, rankings, verification or security
scores. Empty and loading states are distinct; retain zero-valued categories.

Bar entrances, page transitions, hover feedback and slow icon glows respect
prefers-reduced-motion. Labels and values remain readable without animation.
Sign-in/sign-up, logos, Player and all other apps remain outside this styling.

Validation for this update: all 36 destinations reviewed at 1440px, representative
Squad/Fixtures/Rooms/Second Look/Clubs/Staff/Verification layouts at 390px and
900px, with no document-level horizontal overflow. Verification tabs, all nine
Staff & Security disclosures, Account settings and bar/ring controls were
exercised. Ring segments were checked against the loaded counts. TypeScript,
production build, navigation/case/icon checks and four chart-data tests pass.
The 420 existing API calls across ten interaction files are unchanged and Login
is byte-for-byte unchanged. This is a demo-data UI audit, not a claim to have
exercised all backend permissions or failure states.


## Production suite refinement — 6 October 2026

The Founder rejected the repeated green heading bars, generic mastheads, wide
form strips and sentence-packed records shown in the 7:30–7:37 screenshots.
This update supersedes those earlier visual patterns. It is a new implementation
for review, not a claim that the Founder has approved the result.

`scoutSuite.css` follows `scoutCharacter.css` and remains scoped to authenticated
Grassroots. Keep the original logo and brand green, forest palette, restrained
gradients and reduced-motion support. Sign-in/sign-up and all other apps remain
unchanged.

- Film Room is a production workspace with a searchable footage library, actual
  media thumbnails, a central source viewer and a player/observation inspector.
  Playback speed, looping, seeking, focus mode and clip navigation operate on
  the existing footage. The review timeline uses actual media duration. Markers
  are session-only and clearly labelled; observation tags still save through the
  existing API and contribute anonymously to the player's feedback. Do not
  imply editing/exporting footage, persistent markers or private notes.
- Scouting Insight separates discovery activity, review priorities and evidence
  gaps. The funnel columns use returned player counts, keep denominator labels
  and the reporting window, and retain the definition. The birth-quarter chart
  respects suppression and its explanatory note. First assessments, deferred
  reviews, stale evaluations and discovery rotation keep their existing actions.
- Integrations is a workbench with five tools: imports, identity reviews, export
  access, event delivery and provider directory. Counts reflect loaded records;
  disconnected providers remain disconnected. Import review/confirmation and
  credential handling keep the original behaviour.
- Squad, match-day, coaching, friendly and opportunity creation use compact
  disclosures with labelled fields. Briefs use structured dossiers. Coverage,
  decision reviews, video segments, shared resources and dashboard attention
  separate identity, status, dates and actions into readable records.
- Player discovery uses distinct dossier rows with aligned football facts,
  availability, evidence and comparison. It remains unranked by ability or
  evidence confidence. Plan/compliance uses bounded sections with visible
  controls and preserved policy copy.
- Use sentence case for interface labels and readable status values, preserving
  proper nouns/acronyms. `presentation.ts` formats display text only. Never apply
  it to stored enum values, option values, translation keys, IDs or API payloads.

Validation: all 36 navigation destinations reviewed at 1440px; representative
layouts checked at 900px and 390px without document overflow, including expanded
match-day fields. Film Room clip search, switching, playback/pause, speed,
seeking, markers, focus mode and observation selection were exercised. Insight
views and all five Integration tools were opened. Existing API calls and auth
source were compared with the preceding commit. TypeScript, production build,
chart/presentation tests and navigation/case/icon checks pass. This is a demo-data
visual and interaction review, not a claim that all backend permission, empty or
error states have been tested. Rebuild canonical demos after committing and run
the freshness check before replacing the served preview. No push or deployment
is authorized by these instructions.


## Discovery and toolbar correction — 6 October 2026

The Founder explicitly requested further changes to Nobody Missed, Diego Alonso's
Second Look presentation, Player Matching, and the search/notification/report
controls. Preserve the new discovery desk with labelled brief/order controls;
the matching workbench with selectable sources, adjacent required/preferred
editors, position chips and explained result dossiers; and the Second Look
record separating the original decision, dated evidence changes, unresolved
club circumstances and evidence-confidence context. Do not remove warnings or
infer that a new record resolves a club-side constraint.

The Grassroots toolbar uses local `WorkspaceGlyph` SVG artwork and a
shield-based safety control. The Founder subsequently requested a more
traditional search and bell: preserve the wide single-line rounded search
field with a classic magnifier, subtle green border and keyboard shortcut,
and the simple outlined bell in a compact circular forest button with a green
clapper accent. The earlier two-line Finder tile and labelled Updates tile
are superseded. Keep their
accessible names, live status, unread count and original handlers. These replace
the old magnifier/bell/flag presentation at the Founder's explicit request; they
are scoped to Grassroots and do not change the shared logo/icon library or auth.

Validation includes desktop, 900px and 390px layouts, populated matching criteria
and results, recruitment-brief matching, Nobody Missed ordering, Second Look
comparison navigation, notifications and the report dialog. No reports or
recruitment decisions were submitted during review. All 385 existing direct API
calls remain unchanged. The repository build, types and existing UI checks pass.

## Readable criteria and record facts — 6 October 2026

The Founder rejected the dense, dot-separated Saved criteria paragraph and asked
for that format to be replaced throughout Grassroots. Do not concatenate mixed
record properties, criteria or measurements into a wrapping sentence.

- Dynamic Watchlists use individual dossiers with separate Required criteria and
  Preferred criteria lists, preserving every server-provided criterion and its
  group. The same grouping applies to watchlist details and matching results.
  Do not infer criterion types by parsing the server's display strings.
- Use the local `RecordDetails.tsx` components for labelled facts and separate
  list entries. This applies to recruitment, assignments, assessments, trials,
  offers, signing blockers, outcomes, training, verification, imports, groups,
  insight breakdowns and audit records. Keep zero values and missing facts clear.
- Retain short metadata pairs, compact position lists and existing dropdown
  labels where they remain readable. Do not rewrite names or user-authored text.
- Keep the familiar ScoutBox search bar and bell, exact branding and protected
  authentication screens unchanged. These components remain Grassroots-only.

Validation for this refinement: all 36 main navigation destinations reviewed in
the local demo; watchlist details and matching from a recruitment brief exercised;
responsive checks on the affected record layouts. Production build, TypeScript,
navigation and presentation checks pass. All 385 existing direct API calls are
preserved. Demo coverage does not assert that every server state was exercised.

## Compact account panel and simple Home banner — 6 October 2026

The Founder likes the Alex/Manager account treatment but wants it smaller so it
leaves room for navigation. Preserve the compact spacing, 29px avatar and clear
club/safeguarding states; all verification and account controls remain reachable.
The closed panel is approximately 22% shorter than its previous 245px layout.

The Founder rejected both the floating pitch and its replacement touchline
illustration, asking for a simple, professional ScoutBox presentation. The latest
Home banner contains only the headline, a subtle forest gradient, ScoutBox green
accent text and the existing contextual primary action. Do not restore scenery,
freestanding pitch illustrations, decorative terrain or the “Built from the ground up” caption.
`ClubGround.tsx` was removed. Keep the original logo and existing brand colours.
The banner stacks its headline and action on narrow screens without an empty
illustration area. This supersedes all earlier Home artwork directions above.

The compact sidebar and simple banner were checked on desktop and at 390px.
The contextual primary action retains its existing navigation and priority rules.

The sidebar wordmark and Grassroots edition label form a compact left-aligned
lockup: 3px row gap, no extra top margin on the edition, and a 1px optical text
inset. Preserve the actual wordmark, trademark and green brand square.

The Founder subsequently requested texture or embossed pitch lines on the simple
banner. Preserve the faint diagonal turf texture and low-contrast pitch markings
as a decorative background layer. Keep the same banner layout, headline and
action; the markings must not intercept clicks or reduce text readability. This
is a restrained surface detail, not a return to the rejected illustrated scenes.

The Founder approved the embossed treatment and requested that it cover the
entire banner more subtly. The pitch spans the full banner, using the banner
border itself as the pitch boundary, with a circular centre mark and responsive
edge markings. The later request removed the separate 12px inset perimeter;
the halfway line and penalty areas now meet the banner edge. Line alpha
is .10 (previously .23), with a lighter shadow and 1px strokes. Keep the texture
quiet behind both headline and action at every width.

Home's attention queue uses a separate compact heading and individual green-toned
action rows, with a small count badge and Review arrow. Keep the count and label
together, without the previous gold flag, warning border or divided title column.
Rows stack naturally when both inbox and verification need attention; preserve
the existing permission checks, live counts, navigation and zero-count hiding.
The row was checked at 1440px and 390px; Review opens verification.

Club readiness uses compact check rows with explicit status badges, followed by
recruiting position tags and squad coverage. Keep real statuses and existing
verification/squad destinations. The sidebar club identity is a flat nameplate
with a compact initials crest and a quiet edition label, without the large
rounded gradient container. It remains informational, not a fake switch button.
Checked desktop, narrow, and collapsed navigation; phone side panels stretch
to the available width.
