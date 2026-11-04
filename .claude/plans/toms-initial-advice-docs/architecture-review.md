# ScoutBox: architecture and code review

*Reviewed 9 October 2026, on the `design/agent-finance` branch at commit `66c095c`.*

## Summary

ScoutBox is an impressive prototype and a very convincing demo, but it isn't yet a foundation you could take to 100k users. The product and domain thinking are strong, and there's a lot of careful logic around privacy, minors and permissions. The engineering foundations are the weak part:

- There's effectively no database.
- There are no shared types between the server and the apps.
- The code is organised by the order features were built, not by what they do.
- Several key integrations are stubs.

The good news is that the hard thinking about how the product should behave is captured in working code and can be kept. **Expect a significant period of experienced engineering to reach a public beta.** Most of that time goes into rebuilding the data layer and tidying the structure, not into adding features.

### The codebase at a glance

| Item                                                | Size                                                                  |
|-----------------------------------------------------|-----------------------------------------------------------------------|
| Server (`scoutbox-server`, plain JavaScript `.mjs`) | about 94k lines, a large share of it test scripts; 861 HTTP routes    |
| `server.mjs` alone                                  | 4,787 lines                                                           |
| Frontends (TypeScript)                              | Player ~18k lines, Club ~30k, Grassroots ~30k, Agent ~7k, Admin ~2.4k |
| Git history                                         | 379 commits, 315 of them by Claude                                    |
| Root markdown files                                 | about 280 milestone, audit and report documents                       |

### How this review was done

I read the source code directly and ran the server's unit tests. I also benchmarked the cost of saving the database in a separate script.

There are two gaps:

- **I did not run the end-to-end suites.** They need a local server to be started, which I was instructed not to do yet.
- **I did not type-check the frontends.** No app has its dependencies installed.

So this review can't confirm whether those suites currently pass.

---

## 1. Database schema: there isn't really one

This is the most important finding. `scoutbox-server/store.mjs` shows how data is stored:

- **All data lives in one in-memory JavaScript object.** Persistence writes each "collection" (players, orgs, messages and so on) as a single JSON blob into one SQLite table: `collections(name TEXT PRIMARY KEY, value TEXT)`. SQLite is being used as a file, not as a database.
- **Every save writes everything.** Saves are delayed by 2 seconds, but many paths call `persistNow()`, which re-serialises the *entire* database synchronously. Sending a chat message does this (`server.mjs:888-890`).
  - **Benchmark:** 100k players built from the seed data's lean records (about 1.2 KB each) produce 117 MB of JSON. That takes about 0.4 s to serialise and 0.8 s to load.
  - Node runs on a single thread, so the server is frozen for that time.
  - Real records will be far bigger than the seed: timelines, media and activity logs all live inside the player record.
- **Some data grows without limit.** For example, every profile view by a club appends a row to the view log (`ledgerAppend`, `server.mjs:573`).
- **There are no indexes, so every query scans everything.** There are about 766 `db.x.find/filter/some` calls. Even login looks up the session by scanning the whole sessions array (`sessionFor`, `server.mjs:640`).
- **There's no fixed schema.** About 130 collections are created on the fly at startup with `db.x ??= []`, and records are untyped JS objects with nested arrays inside them.
  - There is a migration registry (`m182/migrations.mjs`), which is a good instinct, but it migrates JSON shapes, not tables.
- **On a fresh install, production starts with the seeded demo data.** `buildSeed()` runs whenever no saved snapshot exists.

SQLite on the same host as the server is a perfectly sound plan for an early beta. But reaching it means designing a real relational schema, with foreign keys and indexes, and rewriting the data access behind it. Configuring the current store differently won't get there.

The top-of-file comment in `server.mjs` says "The API surface is designed so storage can swap to Postgres without changes". That isn't true in practice: route handlers mutate the global `db` object directly everywhere.

## 2. Performance on a server

- **There is only one process, and it can't scale out.** All state is held in that one process's memory:
  - the data itself
  - the rate limiters
  - the live-update (server-sent events) clients and their replay log
- **Full-table work happens on every request.**
  - `GET /org/players` (`server.mjs:1826`) builds a view of *every* player, filters it, sorts it and returns the whole list with no pagination.
  - A player-profile view also computes a similarity score against every other player.
- **Expensive work runs on the main thread.**
  - Password hashing uses the blocking `scryptSync` call.
  - Uploads arrive as base64 data URLs inside JSON, with a 20 MB body limit (`server.mjs:305`).
  - A hand-written computer-vision module (`m22/`, about 5.6k lines) runs in JavaScript on the same thread.

**Estimate:** this holds up at demo scale and probably a few hundred active users. It would fall over well before 5k concurrent users. The hard limit is the full-snapshot write.

**On Node vs Go:** Node is fine for this product. The type-safety concern is real, but moving the server to TypeScript would address most of it at a lesser cost than a rewrite. Today the server is plain `.mjs` files with no type checking (no `@ts-check` anywhere), and none of its types are shared with the clients.

## 3. Architecture: a group of apps sharing data

### Server

- **One Express app.** `server.mjs` is 4,787 lines, plus folders named after build milestones (`m12/` … `m29/`).
- **Modules are wired together by passing an ever-growing context object** between them (`{...m18Ctx, ...}`). Placeholder objects are filled in later to break circular dependencies (`server.mjs:4440-4500`).
- **Code is organised by when it was written, not what it does.** To find where a feature lives, you need to know which milestone added it.
- **The comments are mostly milestone history** (e.g. "PRE-M24 (PM-4)", "M23 P5.6F"), not explanations of the current design.

### Frontends

- **The five apps share no code.** There's no shared package or workspace.
  - **Club vs Grassroots:** 31 files are byte-identical (about 6k lines), and about 16 more are over 95% identical (about 11k lines). Roughly 60% of Grassroots is a copy of Club.
  - **Agent** shares several files with Club, and a demo-sync file appears unchanged in Club, Grassroots and Player.
- **Domain types are written out by hand in every client.** For example, `Player` exists in both `scoutbox-club/src/api.ts` and `scoutbox-player/src/domain/types.ts`.
  - API responses are cast with `as T` and not checked at runtime.
  - Club and Grassroots each re-declare the same auth-header helper about 12 times.
- **The web apps have only React and React-DOM as dependencies.** There's no router, data-fetching or state library.
  - Navigation is hand-rolled hash parsing (`scoutbox-club/src/App.tsx:240-251`).
  - All state is local `useState`: about 470 uses each in Club and Grassroots, and 34 in Club's `App.tsx` alone.
  - Several screen files are 1.5–2k lines long.
- **Type checking is reasonably disciplined.** `strict` mode is on in all five apps, with very few `any`s and no `@ts-ignore`.
- **Demo code is mixed into production code.**
  - About 17–23% of each frontend is demo or mock code, imported directly into production modules and switched on a `DEMO_MODE` flag.
  - Metro, the bundler the Player app uses, probably won't remove those imports from production builds.
  - Much of the recent effort, including the project's CLAUDE.md, has gone into polishing self-contained demo HTML files.

### Recommended shape for apps sharing data

1. **A monorepo workspace** (npm or pnpm workspaces).
2. **A shared TypeScript package for domain types and the API client.** Ideally it would be generated from an OpenAPI spec or a validation schema such as zod, and checked at runtime.
3. **A server organised by domain** (players, orgs, recruitment, messaging, agents) rather than by milestone, with a repository/data-access layer between the routes and the database.
4. **Club and Grassroots as one app.** Either one app with variants or two thin shells over a shared component library.

## 4. Testing

- **There are very few real unit tests.** The server has 23 domain tests in `scripts/testTrust.mjs`, and they pass. No frontend has any (no jest or vitest).
- **There are many end-to-end scripts.**
  - **Server:** about 70 API scripts (`scoutbox-server/scripts/m*E2E.mjs`), plus performance and "persistence" scripts.
  - **Browser:** about 75 scripts in `e2e/`, mostly Playwright. Some drive the real app against a live server, some drive the demo HTML bundles, and some are just greps over the source to enforce visual design rules.
- **CI runs only a small part of this:** the 23 unit tests, `apiE2E`, `connectedE2E` and a type-check and build per app. The milestone end-to-end scripts aren't in CI.

The domain logic is fairly pure and testable, so a proper unit-test layer is very achievable once the code is restructured. The existing end-to-end scripts are valuable as a behavioural specification during that restructure.

## 5. Authentication and login

### What's done well

- Passwords are hashed with scrypt and compared in constant time.
- Login is rate-limited both per IP address and per account.
- Sessions expire, and logout revokes them.
- Production refuses to start with a missing or default admin key and some other unsafe settings (`m181/capabilities.mjs`).
- CORS is restricted to an allowlist, and responses carry baseline security headers.
- Org staff can use a TOTP second factor, with one-time recovery codes.

### What isn't beta-ready

- **Players have no email address.** They log in by player ID and password, so there's no password reset and no email verification.
- **Org login is effectively a shared password.** `POST /auth/org/login` (`server.mjs:1724-1795`) works like this:
  1. The caller supplies the org's single password plus *any* `scoutName` and `role`.
  2. If no user with that name exists, one is created on the spot. If one does exist, their role is overwritten with the role that was sent.
  3. Lead permissions are granted by a text pattern on the role name (`/head|director|lead|manager|owner|chief/`, `m13/shared.mjs:211`).

  **Consequence:** anyone who knows the org password can promote themselves to a lead. They can also skip two-factor authentication just by typing a new name.
- **Single sign-on is a stub.**
  - `/auth/sso/callback` trusts codes signed with `TEST_IDP_SECRET`, which defaults to `'local-test-idp-secret'` (`m13/enterprise.mjs:247`).
  - The startup safety check doesn't cover this secret, and the endpoint is registered in production.
  - So for any org with SSO configured, a signed code can likely be forged.
- **Identity verification always approves.** The check that gates creating accounts for minors returns `approved: true` even when an Onfido key is configured (`adapters.mjs:130-149`). S3 storage and Stripe billing are also placeholders behind the same kind of switch.
- **Rate limiting probably won't work on Fly.** `trust proxy` isn't set, so behind Fly's proxy every client will likely share one IP. The 40-requests-per-minute `/auth` limit then becomes a global limit.
- **The admin console** is protected by a single shared `x-admin-key` header.
- **Tokens are stored in plain text.**
  - Session tokens sit unhashed in the database.
  - Web apps keep them in `localStorage`.
  - The native Player app has no secure storage, so its token lives only in memory and is lost when the app restarts.
- **Production builds can silently point at localhost.** The API URL defaults to `http://localhost:4000` when the environment variable is unset.

## 6. Security practices

The intent is good:

- Authorisation checks are usually scoped to the caller's org (`req.org.id`).
- The code tends to fail closed.
- It pays real attention to minors' data.
- There's no `dangerouslySetInnerHTML`, `eval`, or secrets committed to the frontends.

The weaknesses are structural:

- **Responses filter by blocklist, not allowlist.** `playerViewForOrg` spreads the whole player record into the response and deletes the sensitive fields (`server.mjs:1033`). Any new field added to a player leaks to clubs by default.
- **There's no request validation library.** Input checks are ad hoc helpers such as `optText` and `reqText`.
- **Several security components are stubs** (identity verification, SSO, the role-name check). That matters much more for a product that holds data about children.

## 7. Overall assessment

The project is a remarkably complete *product specification that happens to run*. A lot of real thinking has gone into safeguarding, consent, recruitment workflows and how the apps fit together, and that's the valuable part.

As a codebase, it shows what happens when an AI builds feature after feature without anyone owning the architecture:

- huge amounts of commentary about past milestones
- duplicated apps
- no real data layer
- hundreds of markdown "reports" that call things hardened while basic pieces are still stubs

A rewrite from scratch isn't warranted, and neither is pushing on with new features.

## 8. Recommended path to public beta

1. **Freeze features.**
2. **Build a real data layer.**
   - Design a relational schema in SQLite: WAL mode, foreign keys, indexes and per-row writes.
   - Move the server to TypeScript, one domain at a time, and reorganise it by domain.
   - Use the existing route behaviour and end-to-end scripts as the specification.
3. **Testing and operations.**
   - Add a unit-test layer and get the important end-to-end tests into CI.
   - Add structured logging, and later backups and health monitoring.
4. **Fix the identity model.**
   - Email-based accounts with verification and password reset.
   - Real per-user org accounts with invites and server-controlled role assignment.
   - Real identity verification.
   - Real SSO, or drop SSO for beta.
   - Hash session tokens, use secure storage on native, and set `trust proxy`.
5. **Share code across the apps.**
   - Set up the monorepo with a shared types and API-client package.
   - Merge Club and Grassroots.
   - Move demo code out of the production builds.
6. **Scale the hot paths.**
   - Paginate and index the queries.
   - Build responses from allowlists.
   - Move uploads to direct-to-storage (signed URLs) instead of base64 in JSON.

**Tom note**: I recommend getting all of your main architecture tasks done before worrying
about your video-capture features. Then you'll have a good platform to build that off.

### A note on working with AI agents

The project's CLAUDE.md is almost entirely about protecting approved visual designs.
If AI agents keep doing most of the implementation, it would help a lot to add architectural rules there as well, for example:

- "no new top-level `db.x` collections"
- "all data access goes through the repository layer"
- "types come from the shared package"
- "no new milestone-named modules"

At some point after the refactor is done, it would be a good idea to clean out some of the many
top-level markdown files and consolidate the feature lists for each app into its own (brief) README.md.

## 9. Git branch management

### Current state

- **`main` has never been updated.** It contains a single "Initial commit" from 22 July 2026, and it's what GitHub shows by default (`origin/HEAD`). All 378 commits of actual work live only on other branches.
- **The branches aren't really branches.** There are six remote branches, and each is a strict ancestor of the next. Together they form one straight line of history:

  ```
  main (initial commit only)
   └─ claude/desktop-project-migration-wyk3ec   292 commits   26 Sep
       └─ handoff/codex-m24f5                   +50           4 Oct
           └─ handoff/codex-player-vivid-ui     +8            6 Oct
               └─ design/grassroots-clubhouse   +14           6 Oct
                   └─ design/pro-executive      +8            6 Oct
                       └─ design/agent-finance  +7            6 Oct   ← the real "latest"
  ```

  A new branch name was created each time the focus changed, rather than branching off a stable base and merging back.
- **Branch names don't describe their contents.** `design/agent-finance` is named after the Agent app, but it contains *everything*: all the Grassroots, Pro, Player and server work. Someone looking at GitHub has no way to tell which branch is current without inspecting the history.
- **Approved versions are tracked by commit hashes written in CLAUDE.md** (e.g. "approved at `7ee9ecb` on `design/agent-finance`") rather than with git tags. There are no tags in the repository.
- **Several tools commit to the same line of history.** Claude, Codex and people all commit to it, and the work is handed between them by writing handoff documents (`HANDOFF_CODEX.md`, `HANDOFF_CLAUDE_*.md`). Reconciliation is manual. For example, CLAUDE.md warns that a "cloud-only" fix (`9c6249f`) "must be preserved when merging". It did make it in, but only because someone remembered.
- **Scratch files are committed.** Examples are `backup.md` (186 KB) and `e2e/connCheck.tmp.mjs`.
- **CI runs on every push to every branch**, which is good. But with nothing ever merged to `main`, there's no point at which "CI passed" means "this is the version we ship".

### Recommendations

1. **Make `main` the real trunk now.** The history is linear, so `main` can be fast-forwarded to `design/agent-finance` with no conflicts. After that, `main` is always the current product.
2. **Protect `main` on GitHub.** Require a pull request and passing CI before merging, and disallow force-pushes.
3. **Use short-lived feature branches.** Each piece of work, whether by a person or an AI agent, branches from `main`, is merged back through a PR within days and is then deleted. Name branches after the change (`fix/org-login-roles`, `feat/player-email-auth`), not after the last area touched.
4. **Use tags for approved baselines and releases** (e.g. `agent-ui-approved-2026-10-06`, `v0.1.0-beta`) instead of recording commit hashes in CLAUDE.md. Tags are visible on GitHub and can't drift.
5. **Give each AI agent its own branch and PR.** It should never continue another tool's branch directly. The PR is the handoff, and the review step is where conflicts and lost fixes get caught, instead of relying on notes in markdown files.
6. **Delete stale branches once `main` is up to date.** All six are fully contained in `design/agent-finance`, so nothing is lost by removing them.
7. **Deploy only from `main` or tags.**
8. **Keep scratch and backup files out of the repo**, using `.gitignore` or a scratch directory outside the repo.
