# Grassroots Clubhouse design

Implemented for the Founder's 5 October 2026 request for a complete Grassroots desktop makeover: an earthy football feel with gradients and glows, led by ScoutBox green. This is the new implementation for review; it is not a claim of subsequent visual approval.

## Scope and source

The authenticated Grassroots workspace owns this presentation. Its stylesheet is `scoutbox-grassroots/src/clubhouse.css`, loaded after the shared base styles. Every rule is scoped below `:root[data-app="grass"] .grass-workspace`. The exact logo and brand green `#00e676` remain intact. Player, Pro, Agent, Admin and the shared design system are not restyled.

Sign-in and sign-up are explicitly excluded. Keep `Login`, `AuthShell` and auth styles unchanged. The existing appearance hook remains for entry-page compatibility; the signed-in workspace uses a single forest palette independent of saved light/dark preferences. There is no workspace theme switch.

This request supersedes old M24F Grassroots requirements for flat surfaces, no gradients and the old light workspace. It does not supersede permissions, safeguarding, privacy or recruitment state rules.

## Visual direction

- Deep forest and soil-toned surfaces, warm chalk text and muted sage secondary text.
- ScoutBox green on the main action, active navigation, key indicators, pitch edges and restrained glows. Warm sand distinguishes pending or thin-cover states; warnings retain separate colours and text.
- Home as a clubhouse: welcome, one real next action, decorative ground illustration, live endpoint counts, attention, activity, club progress and quick actions.
- Player discovery uses initial avatars, names, locations and compact football facts. Avatars do not imply verification or presence.
- Consistent panels, record spacing, form fields, squad rows, profile drawers and conversations throughout the workspace. Desktop remains the primary layout; smaller windows use the existing navigation drawer and stacked content.
- The ground SVG is decorative, not a map, formation or live squad view. No fabricated metrics, online states, badges or match data.
- Keyboard focus stays visible; reduced-motion users receive no entrance animation.

## Behaviour

Keep existing API calls, navigation permissions, data provenance, guardian-mediated contact, disclosure text and state transitions. Account switching, search, filters, comparison, notes, invitations, reports and recruitment actions retain their handlers. All stats and percentages continue to come from existing records.

## Validation

TypeScript and the production Vite build pass. Existing navigation, case navigation and icon parity checks pass. A source comparison confirms the Login component is byte-for-byte unchanged and the 151 API calls in the four edited interaction files are unchanged. The shared logo/auth/theme files and other applications have no source changes.

Browser review covers Home, player discovery and profile drawer, Squad & Match Days, Coaches, Clubs & Groups, Open Days, Messages, command search and narrow Home/discovery layouts. Demo data is sample data, not a connected production backend.

For a refreshed self-contained demo, run the canonical `node e2e/buildDemos.mjs` with the repository's runtime, then `node e2e/demoFreshness.test.mjs`. Use the resulting Grassroots bundle over HTTP. A local commit or bundle does not update Claude's published artifact automatically. Do not push, merge or deploy without the Founder's authorization for that action.
