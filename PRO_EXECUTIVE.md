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

This changes only Pro presentation. API payloads, access rules, evidence
semantics and the approved Grassroots/Player sources remain unchanged.

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
