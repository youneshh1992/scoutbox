# ScoutBox Agent — black and violet business workspace

Design request dated 6 October 2026. Branch: `design/agent-finance`.
This is a reviewable implementation, not yet a Founder-approved permanent baseline.
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

Agent now has an unboxed directional signature alongside the ScoutBox wordmark.
Opportunities use a searchable, filterable deadline board. Agency views include
member cards, credential records, operating settings and an audit timeline.
Profile work is divided into identity, credentials, authorisations and activity;
compliance into standing, conflict checks, consents and reviews/access. Notifications
use an independently scrolling journal. The world map uses Natural Earth I with
uniform scaling. Cards, maps and charts begin their reveal when entering view.

## Artifact

Run `node e2e/buildDemos.mjs`, then `node e2e/demoFreshness.test.mjs`.
The self-contained Agent artifact is `e2e/dist/scoutbox-agent-demo.html`.
A Git push does not replace a separately hosted Claude artifact. Agent publication
and permanent-baseline approval have not been requested yet.

## Verification

TypeScript, production and demo builds; existing navigation/category and icon
checks; AST comparison of all 81 existing Agent API calls; browser inspection of
the eight primary screens, client/transaction records, search, map filters,
notifications, report tool, access screen and responsive layout.
