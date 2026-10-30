# ScoutBox — approved Agent, Pro, Player and Grassroots UI

## Architecture rules — 9 October 2026

These rules follow the Founder's acceptance of the October 2026 architecture
review. They apply to every tool and person working in this repository and sit
alongside the design approvals below, which they do not change.

### Trunk, branches and approvals

- `main` is the trunk and is always the current product. Every change branches
  from `main`, is named after the change (`fix/org-login-roles`,
  `refactor/data-layer-users`), merges back through a pull request with green
  CI, and is deleted afterwards. Nobody continues another tool's branch; the
  pull request is the handoff.
- Approved baselines are annotated tags (`<app>-ui-approved-<date>`,
  `<app>-baseline-<date>`), not commit hashes in prose. Pushes, merges to
  `main`, tags and deployments happen only on the Founder's explicit
  instruction, and never with a force-push.
- Scratch files, backups and generated bundles stay out of Git. Do not add new
  top-level milestone report files; record durable decisions in the relevant
  README, `scoutbox-server/OPERATIONS.md` or this file.

### Feature freeze

Until the data-layer rebuild below is complete, no new product features are
started. Work in scope: defects, security, the rebuild itself, test coverage,
and design changes the Founder explicitly requests.

### Facts about the data (30 October 2026)

- **There is no production data and no deployment.** Every database in existence is seed or test data and can be
  thrown away. Rollback means "restore a backup or re-seed".
- From S8d onwards, therefore: no new copy-only rollback tools; no new historical-build boots in the gate; no
  compatibility work for files written by earlier development builds; no operator warnings for deployments that do
  not exist. The nine existing rollback tools and their boots stay in the gate until this branch is merged to
  `main`, because they are the only proof the existing chain works; they go with the merge.
- The first real users, and what has to be true for them, are the Founder's questions to answer; the migration plan
  does not assume a date.

### Server structure

- New persistent state is a table owned by a domain repository under `scoutbox-server/repositories/`, created by a
  numbered migration in `repositories/migrations/` and declared in the matching `docs/architecture/sql/*.sql` file.
  No new top-level `db.<collection>` arrays, no new `migrateMxx` collection lines, no new milestone-named modules
  (`m30/…`); new server code lives in `scoutbox-server/domains/<domain>/`.
- Whether a table is authoritative is decided by its record in `data_migrations`, never by the table existing.
  `node:sqlite` with transaction state is required (`runtime.mjs`, refused with `NODE_UNSUPPORTED`); there is no JSON
  or in-memory fallback. The runtime data directory is `scoutbox-server/data/` and is never a source directory.
- Every write to a migrated domain goes through its repository, inside `store.unitOfWork(() => …)` when it touches
  more than one row, a blob, a facet, an audit entry or another domain: synchronous work, one transaction,
  all-or-nothing, the in-memory graph restored on failure; a nested unit joins and its failure fails the whole even
  if caught. Side effects go through `store.afterCommit` (return the promise). A provider call is made before the
  unit, never inside it. A failed unit is answered as a failure, never as success. The old `db.<collection>` is the
  repository's read-only view (a direct write throws). Contract: `OPERATIONS.md`, "Units of work".
- Snapshot writes validate every table-backed collection and reject the whole save on the first problem; never put a
  whole-collection re-projection in the default save path.
- Responses are built from explicit allowlists of fields, never by spreading a stored record. Never log, report or
  export a plain bearer token. Secrets have no default values; every environment-driven setting is registered in
  `scoutbox-server/m181/capabilities.mjs` and documented in `OPERATIONS.md`.
- One definition per rule: shared rules (`roles.mjs`, `domain.mjs`, `temporal.mjs`) are imported, never copied; a
  check needed in a second place is exported from the first.
- **Status of every step, the migrations, the repositories, the acceptances and the Founder's decisions in force:
  the table in `docs/architecture/sqlite-migration-plan.md` §E.** Operating contracts per domain: `OPERATIONS.md`.
  Registration in source is development work, not authorisation for a real-data cutover.
- Target schema and step order: `docs/architecture/sqlite-schema.md` and `sqlite-migration-plan.md`.

### Independent review — scope (30 October 2026)

- One review per step, on the implementation, not the design. A design note of one or two pages (the tables, the
  decisions, how behaviour differs from the old code, the tests) goes to the Founder for the product questions
  without a review cycle.
- A blocking finding is a problem reachable through a real route with data the current build can produce, where a
  real user could lose or corrupt data. Files from superseded development builds, synthetic-only states and
  hypothetical operators are out of scope; anything below that bar is a note, not a finding.
- Questions put to the Founder lead with the product consequence, then the storage mechanism, and say when a
  question does not need the Founder.
- Commit messages: a subject line and a few bullets. Design notes: two to four thousand words. `OPERATIONS.md` does
  not grow until there is something to operate.

### Shared code

- Do not add another copy of an API type or client to an app. The server is
  the source of truth for shapes; a shared types and API-client package is the
  next structural step after the data layer, and new client code should be
  written so it can move there.
- `scoutbox-club` and `scoutbox-grassroots` share their business logic; a fix
  in one is a fix in both until they are merged.

### Tests and CI

- Every server change ships with a test: unit tests in
  `scoutbox-server/scripts/test*.mjs` (run by `npm test`) and, for route
  behaviour, the matching end-to-end script. The existing end-to-end scripts
  are the behavioural specification for the rebuild; a migrated domain must
  pass them unchanged, apart from assertions that exist only to describe the
  old storage.
- CI must be green on `main`. A red step is a defect to fix, not a step to
  skip.

### Milestone gates — documentation housekeeping and unit tests (Founder requirement, 14 October 2026)

These two gates apply **after every milestone for the rest of the project**,
documentation-only milestones included. They override any earlier suggestion
that a documentation change needs no test run. Every handoff and every
next-step prompt restates them and reports their result; they are not a
one-round instruction. This section is the single authoritative statement of
the policy; `AGENTS.md` points here and no other rules document restates it.

**A. Keep the Markdown current; remove what is obsolete.**

- At every milestone, inspect the relevant Markdown files for outdated
  duplicates, abandoned plans, superseded drafts and conflicting guidance.
- Remove files that are genuinely no longer needed. Before removing a
  superseded file, move any still-relevant decision, requirement or
  operational guidance into the current authoritative document and repair
  every link and reference to the removed file.
- Preserve active architecture, schema and migration documents, unresolved
  decision records, required project instructions, current runbooks, and the
  evidence needed to understand or reproduce accepted work. Age alone does not
  make a file obsolete. Do not blanket-delete Markdown, and do not move
  everything into an ever-growing archive instead of cleaning up.
- The milestone handoff lists every deleted or consolidated file with the
  reason; if the review found none, it says so explicitly. The repository must
  end each milestone free of conflicting active instructions.

**B. Run the backend server AND the Player app unit tests.**

*Amendment, the Founder's decision of 30 October 2026:* gate B applies to a milestone that changes anything under
`scoutbox-server/`, `scoutbox-player/` or another package. A milestone that changes only Markdown outside those
packages runs gate A and the privacy sweep, not gate B; its handoff says so. The sentence above about
documentation-only milestones is superseded for gate B and stands for gate A.

- Discover and record the actual commands and working directories from the
  current packages: the backend is `cd scoutbox-server && npm test` (the full
  chain in `scoutbox-server/package.json`); the Player app is
  `cd scoutbox-player && npm test` (Jest with the `jest-expo` preset, tests
  under `scoutbox-player/src/__tests__/`). Do not guess a path or invent a
  passing command. The Agent, Pro and Grassroots apps are not substitutes for
  testing Player.
- Run both suites against the **final** changed tree of the milestone. If code
  or configuration changes after a run, repeat the affected checks and record
  the tested commit or file state accurately.
- If the Player unit-test setup is ever missing or unrunnable, establish the
  smallest suitable setup with the app's existing stack and meaningful tests
  of real behaviour — never an empty suite or tautological tests — and report
  that supporting change separately. If required source or dependencies are
  unavailable, report the precise blocker and mark Player testing **NOT RUN**;
  never "passed" or "complete".
- Fix failures the milestone introduced and rerun. Identify independently
  established pre-existing failures as such; never hide them, silently skip
  tests, or call a failing gate green.
- Wire the actual historical server builds into the rollback proofs of the
  backend gate (the `SCOUTBOX_PRE_*` variables pointing at real checkouts of
  the named commits) and name the commits used; a boot the suites skipped is
  reported as skipped, never as run. Repeat a passing suite only with a stated
  diagnostic hypothesis, not as a campaign.
- Record commands, runtime and tool versions, exit codes and totals for both
  gates. Unit tests are required even when browser or API checks also ran; a
  successful build, lint, screenshot or smoke test is not a substitute.
- A milestone is not "fully verified" while either gate is missing or failing.
  Preserve the evidence and report any blocker plainly. Synthetic fixtures
  only; never real user data or live external delivery services.

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
not assessment; evidence confidence is not a talent score; Nobody Missed is
evaluation coverage, never a ranking. Do not invent data, presence or
verification. Preserve five-category navigation and no authored emoji. The
self-contained demo bundles make no runtime external requests (fonts and
assets are bundled).

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
