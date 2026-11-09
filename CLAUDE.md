# ScoutBox

A football recruitment platform: a Node/SQLite API (`scoutbox-server/`) shared by the Player app (Expo,
`scoutbox-player/`) and four web portals: Pro (`scoutbox-club/`), Grassroots, Agent and the Trust & Safety admin.
How to run and test everything: [`README.md`](README.md). The Founder is not a programmer: explain product
consequences in plain terms, and don't ask him storage questions.

## Before you start

- Read [`docs/decisions.md`](docs/decisions.md): the decisions in force and the open questions. Don't re-ask settled ones.
- Server or storage work: read [`docs/architecture.md`](docs/architecture.md) and
  [`scoutbox-server/OPERATIONS.md`](scoutbox-server/OPERATIONS.md).
- UI work: read [`docs/design.md`](docs/design.md).
- Changing a domain: read its file in [`docs/product/`](docs/product/).

## Facts

- **There is no production data and no live deployment.** Every database is seed or test data. Rollback means
  re-seed. Don't build rollback tools, compatibility with old dev-build files, or operator procedures.
- **Feature freeze until Tom lifts it.** The SQLite migration is complete; the freeze stays while the codebase is
  cleaned up and its architecture tightened. In scope: clean-ups and architecture work, defects, security, tests,
  and design changes the Founder explicitly asks for.

## Server rules

- New persistent state goes in tables owned by a domain repository under `scoutbox-server/repositories/`, created
  by a numbered migration. No in-memory copies of tables, no new milestone-named modules (`m30/…`). New server
  code goes in `scoutbox-server/domains/<domain>/`.
- Writes are explicit repository operations, inside `store.unitOfWork(() => …)` when they touch more than one row
  or domain. Side effects go through `store.afterCommit`. Provider calls happen before the unit. Don't edit
  in-memory records and rely on the save to find the change.
- Store typed columns, and validate and reject junk input at the route. Don't preserve malformed data.
- Responses are built from explicit allowlists, never by spreading a stored record. Never log or return a plain
  token. Secrets have no defaults. Every environment setting is registered in `domains/platform/capabilities.mjs`.
- One definition per rule: import shared rules (`roles.mjs`, `domain.mjs`, `temporal.mjs`), don't copy them.
- Don't add another copy of an API type or client to an app; write client code so it can move to a shared package.
  `scoutbox-club` and `scoutbox-grassroots` share business logic: a fix in one is a fix in both.

## UI rules

- The committed implementation of each app's approved design is the source of truth, not screenshots or old
  bundles. New features fit the approved design. Redesign only when the Founder explicitly asks.
- Work on one app never restyles another app, the shared design system or the auth screens.
- Preserve authentication, permissions, safeguarding, privacy and data provenance through any UI change.

## Tests

- Every server change ships with a test. Unit suites are `scoutbox-server/scripts/test*.mjs` (`npm test`). The
  end-to-end batteries in `scoutbox-server/e2e/<domain>/` are the behavioural specification: rewrite an assertion
  only if it describes old storage, and never delete a behavioural one.
- Before you finish, run `cd scoutbox-server && npm test` if anything under `scoutbox-server/` changed, plus
  `npm run e2e` (about a minute) if a route, a repository or a battery changed, and
  `cd scoutbox-player && npm test` if anything under `scoutbox-player/` changed. Report the results honestly:
  failures, pre-existing failures and anything not run. Use synthetic data only.
- CI must be green on `main`. Fix a red step; don't skip it.

## Reviews

One review per change, on the implementation. A blocking finding must be reachable through a real route with
data the current build can produce, where a real user could lose or corrupt data. Everything else is a note.

## Docs and commits

- **Don't create Markdown files at the repo root, or new docs for a milestone, review, handoff or test run.**
  Design notes and test evidence go in the PR description. When behaviour changes, update the relevant file in
  `docs/` in place.
- Commit messages: a subject line and a few bullets.
- Code comments explain why the code is surprising, not what it does or how it used to work. Don't cite milestones,
  migration steps or PRs in comments; git history has those.

## Git

`main` is the trunk. Branch from it with a descriptive name, and merge back through a PR with green CI. Push,
merge, tag or deploy only when explicitly asked, and never force-push.
