# ScoutBox

A football recruitment platform: a Gleam/SQLite API (`scoutbox-server/`) shared by the Player app (Expo,
`scoutbox-player/`) and four web portals: Pro (`scoutbox-club/`), Grassroots, Agent and the Trust & Safety admin.
How to run and test everything: [`README.md`](README.md).

The Gleam server is replacing the TypeScript server, which stays in `scoutbox-server-ts/` until the switch-over
([`scoutbox-server/docs/final-port-steps.md`](scoutbox-server/docs/final-port-steps.md)). The apps still talk to
the TypeScript server until then. Change it only to keep it running; new server work goes in `scoutbox-server/`.
`README.md`, `docs/architecture.md` and `scoutbox-server-ts/OPERATIONS.md` still describe the Node server.

The Founder is not a programmer: explain product consequences in plain terms, and don't ask him storage questions.

## Before you start

- Read [`docs/decisions.md`](docs/decisions.md): the decisions in force and the open questions. Don't re-ask settled ones.
- Server or storage work: read [`scoutbox-server/CLAUDE.md`](scoutbox-server/CLAUDE.md), which holds the Gleam
  server's rules, and [`docs/architecture.md`](docs/architecture.md) for the product's.
- UI work: read [`docs/design.md`](docs/design.md).
- Changing a domain: read its file in [`docs/product/`](docs/product/).

## Facts

- **There is no production data and no live deployment.** Every database is seed or test data. Rollback means
  re-seed. Don't build rollback tools, compatibility with old dev-build files, or operator procedures.
- **Feature freeze until Tom lifts it.** The SQLite migration is complete; the freeze stays while the codebase is
  cleaned up and its architecture tightened. In scope: clean-ups and architecture work, defects, security, tests,
  and design changes the Founder explicitly asks for.

## Server rules

The Gleam server's own rules (units, effects, typed ids, input shapes, migrations) are in
[`scoutbox-server/CLAUDE.md`](scoutbox-server/CLAUDE.md). These hold for any server code:

- Store typed columns, and validate and reject junk input at the route. Don't preserve malformed data.
- Responses are built from explicit allowlists, never by spreading a stored record. Never log or return a plain
  token. Secrets have no defaults. Every environment setting is read in
  `scoutbox-server/src/scoutbox/platform/config.gleam`.
- One definition per rule. The apps import shared rules from `shared/` (`roles.ts`), not from a server tree. The
  Gleam server can't import them, so it keeps the same rule in one Gleam module that says so
  (`identity/roles.gleam`).
- Don't add another copy of an API type or client to an app; write client code so it can move to a shared package.
  `scoutbox-club` and `scoutbox-grassroots` share business logic: a fix in one is a fix in both.

## UI rules

- The committed implementation of each app's approved design is the source of truth, not screenshots or old
  bundles. New features fit the approved design. Redesign only when the Founder explicitly asks.
- Work on one app never restyles another app, the shared design system or the auth screens.
- Preserve authentication, permissions, safeguarding, privacy and data provenance through any UI change.

## Tests

- Every server change ships with a test. The end-to-end batteries in `scoutbox-server/e2e/<domain>/` are the
  behavioural specification: change the battery first, then the code, and never delete a behavioural assertion.
- Before you finish, run `gleam check`, `gleam format --check src test dev`, `gleam test`, `npm run e2e:check`
  and `npm run e2e` in `scoutbox-server/` if anything under it changed (after a fresh clone, `npm run esqlite`
  first); `cd scoutbox-server-ts && npm test && npm run e2e` if anything under `scoutbox-server-ts/` or `shared/`
  changed; and `cd scoutbox-player && npm test` if anything under `scoutbox-player/` changed. Report the results
  honestly: failures, pre-existing failures and anything not run. Use synthetic data only.
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
