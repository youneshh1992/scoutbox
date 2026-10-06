# ScoutBox — approved Agent, Pro, Player and Grassroots UI

## Latest approval — Agent, 6 October 2026

The Founder approved the finished ScoutBox Agent UI at `7ee9ecb` on
`design/agent-finance` and requested a GitHub push and an artifact ready for
Claude. Read `AGENT_FINANCE.md` and `HANDOFF_CLAUDE_AGENT.md` before Agent work.
Preserve the actual approved implementation: black/violet business workspace,
lavender gradients, stacked ScoutBox/AGENT identity, brand-green accents,
world maps, viewport-triggered motion, compact utility toolbar, refined agency
directory, credential records, operating profile and client portfolio.

Rebuild with `node e2e/buildDemos.mjs`, check with
`node e2e/demoFreshness.test.mjs`, and use `e2e/dist/scoutbox-agent-demo.html`.
A GitHub push does not replace a separate Claude artifact. Replace or rebuild
that artifact explicitly and verify its displayed build ID. Preserve existing
permissions, safeguarding, provenance and all other approved app designs.
This authorizes the requested Agent branch push; it does not authorize a merge
to the default branch, production deployment or future unrelated pushes.

## Latest approval — Pro, 6 October 2026

The Founder approved ScoutBox Pro at `f87f61d` on `design/pro-executive` and
requested a GitHub push and preservation as the permanent Pro baseline.
Read `PRO_EXECUTIVE.md` before changing Pro. Preserve its actual implementation,
including the football entry screen, shared bright Pro lockup, workspace tools,
player dossiers and correspondence desk. Do not reconstruct older screenshots
or restore rejected generic layouts. New features must fit the approved UI.

Use `e2e/dist/scoutbox-club-demo.html`, built with `node e2e/buildDemos.mjs` and
verified with `node e2e/demoFreshness.test.mjs`, for the Pro artifact. A separate
Claude artifact requires rebuilding or replacing its bundle; a source push alone
does not update it. This approval does not change Player or Grassroots.
The current Pro push is authorized, not a merge, deployment or future push.

## Latest approval — Grassroots, 6 October 2026

The Founder explicitly approved the Grassroots UI at commit `5a3e7b0` on
`design/grassroots-clubhouse` and requested that it be pushed to GitHub and used
for the Grassroots artifact going forward. This is the approved baseline, not
an unfinished redesign. Preserve the actual implementation and subsequent
authorized changes; do not rebuild it from a screenshot or restore older demo
HTML. Read the approval at the top of `GRASSROOTS_CLUBHOUSE.md` before changing
Grassroots. Its final decisions supersede earlier exploratory design directions.

Build the Grassroots artifact from these sources using the canonical demo builder
and freshness check. The GitHub push is authorized for this approval; this is not
standing permission for future pushes, merges, or deployments.

The Founder approved the current Player design and explicitly asked Claude to
preserve it going forward. These are persistent project instructions. A later
explicit Founder request may revise them; do not infer a redesign request
from unrelated feature or bug-fix work.

## Source of truth

- Approved implementation checkpoint: `99de825` on
  `handoff/codex-player-vivid-ui`.
- Read `HANDOFF_CLAUDE_UI.md` and the final approval section of
  `BRAND_RULES.md` before changing Player UI.
- Use `design-system/approved-player-ui/README.md` to identify current
  reference captures. Earlier conflicting design notes are superseded.
- Keep the actual committed components and styles. Do not recreate the app
  from a screenshot, replace it with a simplified mockup, or restore older
  cached artifacts. Preserve subsequent authorized changes as well.

## Preserve these design decisions

- Exact ScoutBox logo and #00e676 brand green; system UI typography, SF Pro
  on Apple, with the existing wordmark typography.
- Player is permanently dark-only, per the Founder’s latest instruction.
  Preserve the approved dark palette, canvas and semantic icons. Do not restore
  light mode, OS-following appearance, theme switches or Appearance settings.
  Gradient controls retain 70% opacity; labels/icons stay opaque. Home hero
  opacity is .49 and its CTA is .56. Saved light preferences must be ignored.
- Location first and bordered position badge second on one row; bordered
  availability pill below. Profile/Football centre the group below the name.
  Home retains its approved placement above/below the name respectively.
- Bright blue verification seal after the name: 20.9px, 6px gap, centred
  alignment with a 1px downward optical offset. Only render it when the
  existing identityVerified data is true.
- Social inbox with search, avatar shortcuts, filters and unboxed preview
  rows opening full conversations. Squared message bubble and overlapping
  unread count. Preserve the approved dark treatment.
- Structured invitations, compact goal actions and author-led reviews.
  Flat record details and clear action areas across agents, representation,
  transitions, exposure, requests, references, transactions and check-ins.
  Do not restore nested grey boxes or stacks of generic explanatory cards.
- Shared connected timeline rails with green points and gentle pulses;
  respect reduced motion. Preserve the approved notification presentation.

## Behaviour and validation

Keep existing authentication, tenant isolation, safeguarding, guardian-managed
minor contact, consent acknowledgements, state transitions and action handlers.
Never expose internal club notes. Offer acceptance is not signing; Box Cam is
not assessment; evidence confidence is not a talent score. Do not invent data,
presence or verification. Preserve five-category navigation and no authored emoji.

For changes, run relevant checks and inspect affected screens in dark mode
and narrow layouts, including a previously saved light preference. Do not use superseded minimalism tests as a reason to
revert the Founder-approved design. Do not silently remove behavioural tests.

Build the real app without EXPO_PUBLIC_DEMO. For self-contained demo updates,
use `node e2e/buildDemos.mjs` and `node e2e/demoFreshness.test.mjs`; use the new
`e2e/dist/scoutbox-player-demo.html`, served over HTTP(S). Demo sample data is
not a production backend. An external Claude artifact does not update merely
because these files or Git history changed; replace/rebuild it explicitly when
the Founder asks. Never claim an artifact was updated without verifying it.

No push, merge or deployment is authorized by these standing instructions.

The dark-only change does not alter Grassroots. The Founder will start that
project separately. The cloud-only badge fix 9c6249f must be preserved when
merging this branch into Claude’s existing workspace; it was not on GitHub
when the dark-only update was prepared.

## Grassroots Clubhouse — new makeover

The Founder has now started the separate Grassroots redesign, with full creative
control except the logo and brand colours, and an explicit requirement to leave
sign-in/sign-up as they are. Read `GRASSROOTS_CLUBHOUSE.md` before Grassroots UI
work. The current implementation uses an earthy forest workspace, green gradients
and glows, a clubhouse Home and consistent player/club/recruitment screens. This
supersedes earlier Grassroots light/flat/minimalist presentation instructions;
it does not alter the approved Player baseline or protected business rules.
Keep the new styling scoped to authenticated Grassroots. Preserve the existing
authentication pages and exact ScoutBox logo and #00e676 brand green.

The follow-up Grassroots refinement uses `scoutDesk.css` after `clubhouse.css`:
professional scouting registers, compact operational sections, a desktop Film
Room and structured player dossiers. Preserve this direction across every
workspace page; avoid reintroducing repeated rounded cards around paragraphs.
The Clubhouse hero and earthy ScoutBox green identity remain. See the refinement
and validation scope in `GRASSROOTS_CLUBHOUSE.md`.

The 6 October Grassroots refinement adds `ScoutVisuals.tsx` and the scoped
`scoutCharacter.css`: a compact account/club-standing panel, semantic page
mastheads, position coverage on a pitch, count charts with optional bar/ring
views, fixture columns and reduced-motion-aware animation. Preserve truthful
count scopes and distinct loading/empty states; never manufacture scores or
verification. See `GRASSROOTS_CLUBHOUSE.md` for the durable design rules.


The subsequent 6 October studio refinement supersedes the green-edged generic
mastheads, ruled section headings and broad green form strips above. Load
`scoutSuite.css` after `scoutCharacter.css`. Preserve the three-panel Film Room
(clip library, viewer/timeline, player observations), the Scouting Insight
activity/review/evidence views, and the Integrations workbench. Use labelled
creation disclosures, brief dossiers and structured operational records rather
than sentence-packed rows. English interface copy uses sentence case; stored
enums, IDs, translation keys, names and user-authored content stay unchanged.
Film Room timeline markers are explicitly session-only; observation tags use
the existing persistence and anonymity rules. Read the latest section of
`GRASSROOTS_CLUBHOUSE.md` before making further presentation changes.


Preserve the subsequent discovery/toolbar correction in
`GRASSROOTS_CLUBHOUSE.md`: Nobody Missed's brief desk, Player Matching's two-part
criteria workbench, the structured Second Look dossier, and the custom local
search/bell/safety SVG controls. The Founder explicitly rejected the preceding
layouts and toolbar icons.

The Founder then refined the toolbar again: search should look like a traditional
search bar, and notifications like a traditional bell, with restrained ScoutBox
green accents. Preserve the single-line search field and circular bell control;
do not restore the two-line Finder or labelled Updates tiles.

The Founder also rejected dense, dot-separated criteria and record summaries
across Grassroots. Preserve the grouped required/preferred criteria in watchlist
list/detail and matching results, and the labelled facts/separate list entries
provided by local `RecordDetails.tsx`. Do not restore wrapping mixed-data
paragraphs. See the latest readable-record rules in `GRASSROOTS_CLUBHOUSE.md`.

Preserve the compact Grassroots account panel and simple Home banner described
in the latest section of `GRASSROOTS_CLUBHOUSE.md`. The Founder rejected both
pitch illustrations. Home now uses only its headline, subtle forest background,
ScoutBox green and the contextual primary action. Do not restore scenery or the
“Built from the ground up” caption. Keep the smaller account panel.

The latest Home refinement adds a faint turf texture and embossed pitch-line
background at the Founder's request. Keep it subtle behind the existing content;
retain the simple layout and avoid restoring the rejected scenic illustrations.
