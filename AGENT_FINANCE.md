# ScoutBox Agent — black and violet business workspace

## Founder approval — 6 October 2026

The Founder approved the finished implementation at `7ee9ecb` on
`design/agent-finance`: “This is good to go and ready to push for github and
ready for claude to use as an artifact”. This is the approved Agent baseline.
Preserve the committed components/styles and subsequent authorized changes;
do not reconstruct earlier screenshots or restore rejected generic layouts.
New features must fit this design. Redesign only on an explicit Founder request.
Read `HANDOFF_CLAUDE_AGENT.md` for artifact delivery and integration instructions.
This approval authorizes the current branch push and handoff, not a default-branch
merge, production deployment or standing permission for future publishing.

## Original direction

Design request dated 6 October 2026. Branch: `design/agent-finance`.
The request covers all Agent screens and sign-in/access, while retaining the
ScoutBox wordmark, close trademark and signature green. References call for
black/purple financial software, lavender/pink gradient light, maps and charts.

## Implementation

- `scoutbox-agent/src/agentFinance.css`: app-local dark palette, gradient surfaces,
  compact navigation, search and tools, ledgers, category navigation and forms.
- `AgentVisuals.tsx`: shared Agent brand, headings, interactive world map, real
  permitted-record counts, portfolio distribution, activity chart and register.
- `AgentExperience.tsx`: viewport-triggered reveal motion with reduced-motion support,
  keyboard-accessible desk tabs, and notification presentation.
- `App.tsx`, `navui.tsx`, `screens.tsx`, `transactions.tsx`: entry/access, workspace,
  client search/filter, record headers, transaction register and correspondence.
- `assets/worldCountries.json`: bundled Natural Earth country outlines; public
  domain provenance and transformation documented in `assets/MAP_SOURCE.md`.
- Authentication remains agency-managed. Get access explains the existing route;
  it does not invent public registration, payment, invitation or identity flows.

The geography uses only permitted active client records with a known country.
Charts show recorded representation activity, not financial performance. The ring
covers active, pending, disputed and expired states; it is labelled accordingly.
No invented revenue, fees, valuations, agency reach, signatures or permissions.
Existing API calls and business rules remain intact. Verification, restrictions,
consents and provenance continue to reflect server answers.

All styling is local to Agent. Pro, Grassroots, Player, shared styling and backend
sources remain unchanged. Do not replace approved app designs with this theme.

## Latest refinement

Agent now has a stacked typographic signature: the ScoutBox wordmark above a
spaced violet AGENT edition line. The top toolbar uses an understated search line,
a labelled updates control and a shield-shaped report tool.
Opportunities use a searchable, filterable deadline board. Agency views include
a compact member directory with on-demand access editing, aligned credential
records, an operating profile with market toggles and an audit timeline. Client
registers distinguish shared summaries from own relationships, with explicit
filtered-empty states. The account area integrates identity and assigned access.
Profile work is divided into identity, credentials, authorisations and activity;
compliance into standing, conflict checks, consents and reviews/access. Notifications
use an independently scrolling journal. The world map uses Natural Earth I with
uniform scaling. Cards, maps and charts begin their reveal when entering view.

## Artifact

Run `node e2e/buildDemos.mjs`, then `node e2e/demoFreshness.test.mjs`.
The self-contained Agent artifact is `e2e/dist/scoutbox-agent-demo.html`.
A Git push does not replace a separately hosted Claude artifact. The Founder has
approved this design and requested the branch push and Claude-ready handoff.
The generated HTML is intentionally ignored by Git; rebuild it from the approved
branch or use the separately supplied self-contained handoff bundle. Serve over
HTTP(S) and verify the build ID before claiming the artifact was updated.

## Verification

TypeScript, production and demo builds; existing navigation/category and icon
checks; AST comparison of all 81 existing Agent API calls; browser inspection of
the eight primary screens, client/transaction records, search, map filters,
notifications, report tool, access screen and responsive layout.
