# ScoutBox docs

| Read this | When |
|---|---|
| [`decisions.md`](decisions.md) | Always. The decisions in force (process, data, UI, product) and the open questions. |
| [`architecture.md`](architecture.md) | Before any server or storage work. How the data layer works, the rules for server code, and how to add a table. |
| [`design.md`](design.md) | Before changing any UI. The Founder-approved designs for each app and the cross-app UI rules. |
| [`product/`](product/) | Before changing a domain. How it works and what must stay true. |
| [`known-issues.md`](known-issues.md) | Known defects, performance limits and flaky tests, not yet fixed. |
| [`reference/`](reference/) | Research and catalogues: agent regulations (Sept 2026), the recruitment metric catalogue, the Combine validation protocol. |

Product docs:

- [`recruitment.md`](product/recruitment.md): cases, Rooms, lifecycle, contact, trials, formal decisions
- [`offers-signings.md`](product/offers-signings.md): offers, signing packages, signings, follow-ups, outcome reports
- [`journey-analytics.md`](product/journey-analytics.md): recruitment journey, next actions, analytics, matching, watchlists
- [`agents.md`](product/agents.md): football agents, compliance, transactions
- [`passport-development.md`](product/passport-development.md): Football Passport, verification, Trust, Development Hub, Box Cam, Combine, CV
- [`safeguarding.md`](product/safeguarding.md): minors and guardians, blocks and reports, privacy, sign-in and sessions
- [`navigation.md`](product/navigation.md): app navigation, information architecture, terminology
- [`platform.md`](product/platform.md): errors, boot, dates and time zones, capabilities, sessions, codes, notifications, deployment

Elsewhere: [`../scoutbox-server/OPERATIONS.md`](../scoutbox-server/OPERATIONS.md) (running the server, environment
variables, backups, adapters), [`../design-system/README.md`](../design-system/README.md) (shared tokens and
components), [`../e2e/README.md`](../e2e/README.md) (end-to-end tests and demo builds).

## Keeping the docs useful

- Update these files in place when behaviour changes. Don't add new files for a milestone, a review or a test run;
  that belongs in the PR description.
- Write down what is true now and why, not how it got there: git history has that. Older milestone documents are
  archived under the tag `docs-archive-2026-11` (`git show docs-archive-2026-11:<FILE>.md`).
