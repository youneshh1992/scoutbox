# Approved ScoutBox Agent — Claude handoff

The Founder approved the completed Agent UI on 6 October 2026 at `7ee9ecb` on
`design/agent-finance`, and requested the source be pushed to GitHub and made
ready to use as a Claude artifact. This is an approved design, not a proposal.

## Source and integration

Repository: https://github.com/youneshh1992/scoutbox

Branch: `design/agent-finance`

Read `AGENTS.md`, `CLAUDE.md` and `AGENT_FINANCE.md` first. Fetch the branch and
inspect it in a separate worktree before integrating into an existing checkout.
Keep uncommitted work and any cloud-only commits. Do not reset an existing
checkout to this branch or overwrite newer backend or other-app changes.
The Agent implementation commits follow Pro approval checkpoint `5b0f6da`;
review `git diff 5b0f6da..origin/design/agent-finance -- scoutbox-agent` for the
Agent-specific source changes. Resolve integration conflicts while preserving
both the approved Agent presentation and current business logic.

## Preserve the approved result

- Black/violet business workspace, lavender/pink gradient light and ScoutBox
  green brand accents. Keep the ScoutBox wordmark and close trademark.
- Stacked AGENT edition lettering and aligned accent line. Do not restore the
  rejected line-art A logo or the Pro badge.
- Understated search line, labelled Updates control and shield report tool.
- Natural Earth world maps with uniform scaling, permitted client geography,
  record-based charts and viewport-triggered motion with reduced-motion support.
- Entry/access screen, opportunities board, notification journal, profile and
  compliance tabs, transactions and correspondence.
- Compact team directory with on-demand Manage access, draft discard, aligned
  licence/registration records, agency description/market settings, client
  portfolio with summary-only shared records and integrated account identity.

Keep authentication, tenant isolation, safeguarding, consent, verification,
provenance, action handlers and server permissions intact. Do not invent revenue,
valuations or reach. Do not expose private client data through shared summaries.
Pro, Player and Grassroots have separate approved designs; leave them intact.

## Build the artifact

Use Node 22+ and install dependencies from the existing lockfiles for the five
apps and `e2e` if they are not already installed. From the repository root:

```sh
node e2e/buildDemos.mjs
node e2e/demoFreshness.test.mjs
```

Use the complete **`e2e/dist/scoutbox-agent-demo.html`** as the Agent artifact.
It is a self-contained interactive demo with explicit sample data, sandboxed
storage protection, source fingerprint and build ID. Generated artifacts are
intentionally ignored by Git. The handoff ZIP also supplies this HTML directly.
Serve it over HTTP(S), or use a host that supports the complete HTML artifact.
Do not substitute a simplified mockup or paste only a fragment of its bundle.

Replace/rebuild the existing Agent artifact explicitly, then open it and verify
the displayed build ID. A source push alone does not update an external artifact.
If the host cannot accept the full HTML, report that limitation and use a
supported preview host rather than claiming the artifact was updated.

For a connected production build, run the existing Agent build without
`VITE_DEMO=1`; sample-data artifacts are not production deployments.

## Validation

The approved implementation passed TypeScript, production/demo builds,
navigation/category and icon checks, and an AST comparison preserving all 81
existing Agent API calls. Browser review covered the primary screens, access,
maps, tools, records, responsive layout, role draft discard and summary-only
client access. The final canonical bundle must pass the freshness checks.
This handoff does not claim every role/state permutation or native device path
has been retested. No default-branch merge or production deployment is included.
