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
