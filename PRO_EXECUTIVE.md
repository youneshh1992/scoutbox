# ScoutBox Pro — executive design direction

Implemented on `design/pro-executive`, 6 October 2026. This is a reviewable
design proposal, not a recorded Founder approval or authorization to publish.

The Founder requested a luxury identity for the paid flagship, clearly distinct
from Grassroots, with visual data, restrained animation and usable workflows.
They explicitly included the Pro sign-in/access screen in the redesign scope.

## Implementation

- Pro-only graphite and midnight surfaces, ivory text and ScoutBox green accents.
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
