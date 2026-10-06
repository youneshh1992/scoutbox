# ScoutBox Pro — approved UI and artifact baseline

## Founder approval — 6 October 2026

The Founder approved the finished Pro result and explicitly requested that it
be pushed to GitHub and made the permanent Pro baseline.

- Approved implementation: `f87f61d` on `design/pro-executive`.
- Source of truth: the actual `scoutbox-club` implementation at this checkpoint
  and subsequent authorized changes. Earlier screenshots, generated HTML and
  exploratory descriptions are not alternative baselines.
- Preserve the charcoal and pitch-green professional workspace, ScoutBox green,
  compact workspace navigation, football sign-in screen and its access flow.
- Preserve the shared ScoutBox Pro lockup: trademark tucked above the green
  square, aligned outlined Pro badge with its brighter green border and lettering.
- Messages retains the compact correspondence log, conversation filters,
  expandable football context panel, multiline composer and editable reply
  starters. Do not restore the rejected bulky bubble-chat layout.
- Keep the traditional typeable search field, bell/Alerts control and separate
  red report tool; warnings use readable red treatments.
- Preserve the player discovery cards and centred dossier with Overview,
  Footage, Evidence and Club notes tabs. Verification uses the existing seal
  shape in ScoutBox green. Keep the Film Room tools and refined category layouts.
- Responsive layouts, reduced motion, authentication, permissions, safeguarding,
  privacy, provenance and working actions remain protected. Demo conversations
  and sample context stay explicitly labelled and isolated from real messaging.
- New Pro features must fit this approved design. Redesign only when explicitly
  requested by the Founder. Player and Grassroots approvals remain unchanged.

### Artifact handoff

Build from this branch or a descendant containing the approved implementation:

```sh
node e2e/buildDemos.mjs
node e2e/demoFreshness.test.mjs
```

Use `e2e/dist/scoutbox-club-demo.html` for the Pro artifact. This self-contained
bundle is generated and intentionally ignored by Git; its build ID and source
fingerprint identify the source. Serve it over HTTP(S). Build `scoutbox-club`
without `VITE_DEMO=1` for production.

A separate artifact host, including Claude, must rebuild or replace its Pro
bundle from these sources. A GitHub push alone does not update a separately
published artifact. Verify the displayed build ID before claiming it refreshed.

This approval authorizes the requested Pro branch push, not an automatic merge,
production deployment or standing authorization for future publishing.

The sections below are implementation history. This approval and the final
implementation supersede earlier references to a proposal awaiting review.

## Original executive design direction

The Founder requested a luxury identity for the paid flagship, clearly distinct
from Grassroots, with visual data, restrained animation and usable workflows.
They explicitly included the Pro sign-in/access screen in the redesign scope.

## Implementation

- Pro-only charcoal surfaces, ivory text and ScoutBox green accents.
  Preserve the ScoutBox wordmark and its green square; primary actions use
  `#00e676`.
- A recruitment overview with links to real workflows, actual account counts,
  and accessible bar/ring charts. Counts are records, not player ability scores.
- Film Room has a clip library, native video controls, timecode, seek control,
  playback speed and a player observation panel. Existing tag submission and
  clip-view APIs remain in use.
- Discovery cards separate location and player facts. Scouting Insight presents
  coverage and birth-quarter data visually while preserving small-group
  suppression. Membership terms use existing plan data.
- The entry screen uses the same Pro palette. Authentication remains the
  existing provisioned organisation flow; no public sign-up service is claimed.
- Keyboard focus, mobile layouts, disabled states and reduced-motion preferences
  are retained. The dedicated Pro palette has no workspace theme toggle.

The implementation lives in `scoutbox-club/src/proExecutive.css`,
`proRefinements.css`, `proDesign.tsx`, and the existing Pro screen components. Other apps and the
shared design system are unchanged.

## Refinement after Founder review

The Founder requested a tighter ScoutBox Pro wordmark, a sidebar structurally
distinct from Grassroots, and the same readability corrections applied to Pro.
The Pro label now sits next to the wordmark. Six compact workspace tiles switch
the navigation context; the page index shows the selected workspace. The
account area keeps Alex and the role visible, with organisation status inside
Account settings. Collapsed navigation retains its keyboard-operable flyouts.

Saved criteria are separated into required and preferred groups. Matching has
a two-column criteria editor. Nobody Missed starts with a labelled brief/sort
panel. Second Look separates the original decision, new evidence, club
circumstances and confidence context. Recruitment briefs, observations,
objectives, network shares and decision reviews use distinct facts and dates.
Integrations has a horizontal tool selector, with each existing workflow kept
in its own panel. Labels, errors and status wording use consistent sentence case.

These presentation refinements preserve API payloads, access rules, evidence
semantics and the approved Grassroots/Player sources. The additional Pro tools
below use existing endpoints and permissions.

## References

- [Wyscout Scouting Area](https://www.hudl.com/products/wyscout/scouting-area):
  keep video, evidence and recruitment context close together.
- [Statsbomb](https://www.hudl.com/products/statsbomb): clear football data
  presentation.
- [SkillCorner football](https://www.skillcorner.com/sports/football): visual
  comparison and analysis workflows.

These are workflow references, not integrations, endorsements or sources of
the data displayed by ScoutBox.

## Validation and delivery

TypeScript and the production build pass. Navigation configuration passes 504
checks, case navigation passes 127, and icon parity passes. An AST comparison
preserves all 367 existing API calls in modified Pro files. Browser checks
cover entry, overview, discovery, Film Room, chart switching, membership and
390px mobile layouts. Refinement checks also cover matching a position,
watchlist criteria, Second Look, Nobody Missed, integrations tool switching,
collapsed navigation and the mobile workspace drawer. The inspected preview
has no console errors.

Build distributable artifacts with `node e2e/buildDemos.mjs`, then run
`node e2e/demoFreshness.test.mjs`. The Pro artifact is
`e2e/dist/scoutbox-club-demo.html`. Generated HTML is not the source of truth.
Publishing a source commit does not update an external Claude artifact.


## Pro workspace tools and presentation — 6 October follow-up

The Founder requested a deeper Pro redesign and features exclusive to this app.
The new Pro layer uses graphite and blue-slate surfaces, ScoutBox green actions,
original two-tone navigation glyphs, a shield-shaped club identity, a compact
account footer and category selectors with descriptive page entries. The
workspace tiles stay visible while the page index scrolls. Traditional search,
notification and reporting actions retain their existing behaviour.

- Film Room adds an in/out timeline, range looping, 0.04-second precision steps,
  J/K/L and I/O shortcuts, event labels, private notes, saved segment recall and
  existing-playlist assignment. Segments save through the existing M12 API and
  appear in Evidence & Video. Range validation respects the ten-minute limit;
  precision steps are time increments, not guaranteed source-frame steps.
- Discovery offers dossier and list views plus CSV export of the visible,
  permitted player fields. Spreadsheet formula prefixes are escaped.
- Analytics offers bar and table modes, CSV export, and ring views for additive
  categories. Funnel stages do not use a ring or a summed total, because the
  same players can appear at multiple stages. Small-group suppression remains.
- Squad Planner has an interactive pitch of recorded role groups and an
  inspector for required/preferred facts. It does not invent a starting XI.
- Network separates relationships, shared access and transition packs. Its
  selectable diagram uses recorded group members, not geographic or inferred
  links. Existing grant, revocation and transition-access controls remain.

The additional files are `proExperience.tsx`, `proExperience.css`,
`proClipTools.tsx`, `proClipModel.ts` and `proExport.ts`. These are Pro app
features; Grassroots and Player sources are unchanged. Server authorization
remains authoritative. No new subscription-billing rules are introduced.
The demo stores annotations in tab memory and now resolves each source clip to
its actual player and media URL instead of hard-coding the first player.

Additional workflow references: [Linear's design refresh](https://linear.app/now/behind-the-latest-design-refresh),
[Stripe's dashboard](https://stripe.com/blog/dashboard-updates-oct-2020), and
[DaVinci Resolve's editing workspace](https://www.blackmagicdesign.com/products/davinciresolve/edit/).
These informed hierarchy, focused tools and visual organisation, not copied
branding or claims of integration.

Validation for this follow-up: TypeScript, production/demo build, 504 navigation
checks, 127 case-navigation checks, icon parity and 18 Pro utility checks.
Browser checks cover saved segments on a second player and their linked profile,
playlist assignment, chart modes, dossier/list switching, role selection,
network tabs, desktop and 390px layouts. The Pro preview remains a local design
proposal until the Founder approves it.

## Football identity and category layouts — 6 October review

The latest Founder feedback requested a stronger football identity, a substantial
entry-screen redesign, cleaner categories, and a grammar/alignment pass. This
iteration supersedes the blue-slate presentation above. It remains a local
review proposal; Pro publishing has not been requested.

- `proFootball.css` is the final Pro-only presentation layer: charcoal, muted
  pitch-green surfaces, ivory typography, square controls and restrained green
  accents. Traditional search, notification and report controls remain active.
- The entry screen uses `src/assets/pro-stadium.jpg`, an original AI-generated
  stadium image, with a shorter named-user sign-in form. Organisation selection,
  password reveal, validation, loading state and the existing login API remain.
  “Get access” explains the existing administrator invitation/provisioning flow;
  it does not claim to create accounts or introduce public registration.
- Discovery aligns filters, collapses optional saved-search and ordering details,
  retains visible comparison actions, and removes duplicate position badges.
- The activity feed separates event type, player, context and date. Attention
  requests use a compact action rail. Repeated page-signature ornaments are
  replaced by a small football stripe motif.
- Campaigns separate creation, deadlines, submission counts and review actions.
  Review copy describes upload checks without exposing internal enum names.
- Squad contracts use a full-width personnel register and readable dates.
  Club setup shows actual completion progress and a two-column task board.
- Analytics tables fill their panel; empty charts explain the lack of recorded
  activity without manufacturing sample results. The compact account control
  keeps status, language and session actions inside its expandable menu.
- Native dark form controls also work for previously saved light-mode sessions.
  Desktop and narrow layouts, reduced motion and keyboard focus are retained.

Validation: TypeScript and production build; 504 navigation, 127 case-navigation,
18 Pro utility checks and icon parity. AST comparison confirms all 371 existing
API calls are preserved with unchanged arguments. Browser checks cover entry
validation, organisation selection, password reveal, access guidance, player
comparison, campaign review, club setup, squad records, chart/table switching,
Film Room and the mobile navigation/discovery layout at 390px. The inspected
browser session reports no console errors. Canonical demos must still be built
from the committed source and pass freshness verification before delivery.

## Dossiers, messaging and utility tools — 6 October detail review

The header now has a typeable workspace search field, a traditional bell with an
Alerts label, and a separate red report control. The notifications panel and
report form share the Pro treatment. Reports retain their existing review and
urgent communication-suspension behaviour.

Discovery uses a compact search/filter bar and player identity cards with shirt
position markers, structured facts and comparison controls. Player profiles open
as centred dossiers with Overview, Footage, Evidence and Club notes tabs. Existing
profile actions remain available, with secondary actions grouped in a menu.
Verification keeps the existing badge geometry and uses ScoutBox green #00e676.
Access warnings now use dark red surfaces, a red edge and readable light text.

Messages uses a responsive inbox and conversation view. Demo builds include an
explicitly labelled fictional adult conversation with Jordan Ellis. Preview
replies remain in component memory: they do not create requests, send messages,
mark actual channels read, or appear in connected production builds. Real threads
retain the existing messaging API, attachments, moderation and guardian rules.

Validation: TypeScript and production build; 504 navigation, 127 case-navigation,
18 Pro utility checks and icon parity. AST comparison confirms all 371 existing
API calls and their arguments are preserved. Browser checks cover search,
notifications, report form, comparison selection, all dossier tabs, contact-form
opening/cancellation, the green verification colour, sample replies, and desktop
and 390px layouts. No external reports or messages were submitted. Canonical
artifacts are rebuilt from the local commit and checked for freshness before
preview delivery. Grassroots and Player source are unchanged; no publishing.

## Correspondence desk and Pro lockup — 6 October follow-up

The Founder rejected the generic bubble-chat presentation. Messages now uses a
compact correspondence log with author markers and time stamps, a narrow inbox,
conversation filters, an expandable context file and a multiline composer.
Availability and training-visit starters fill an editable draft; they never send
a message automatically. Ctrl/Cmd+Enter submits, while Enter adds a new line.
The fictional demo conversation remains clearly labelled and isolated from real
channels; its football position visual and visit context are sample-only.
The real messaging, attachments, receipts, moderation and guardian rules remain.

A shared ProBrand lockup now serves the sign-in page and both navigation layouts.
The trademark sits above the wordmark's green square. The existing outlined Pro
badge uses a #00e676 border and brighter lettering, including the separate club
access badge. This supersedes the muted badge colours in earlier style layers.

Validation: TypeScript, production build, 504 navigation checks, icon parity and
18 Pro utility checks. All 371 existing API calls retain their arguments. Browser
review covers desktop/mobile Messages, draft starters, local sample replies,
conversation search and details, sign-in branding, badge colours and overflow.
The inspected session has no console errors. Build canonical demos and verify
freshness after this commit. This remains local Pro review work, not publishing.
