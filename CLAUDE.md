# ScoutBox — permanent approved Player design

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
