# Application-layer architecture improvements

The storage layer (`repositories/`, `store.mjs`) is a sound foundation: typed STRICT tables with CHECKs, state
transitions guarded in SQL, synchronous units of work with `afterCommit` side effects, persisted sweeps, the visibility
rule in SQL and match facts kept by triggers. The layer above it, the routes, the wiring in `server.mjs` and the
contracts between domains, hasn't had the same treatment, and it is where difficulty will build up once feature work
resumes. This document lists the improvements and the order to make them in. Each is architecture work within the
feature freeze, and none needs a rewrite: the end-to-end batteries make every step safe to take in small pieces.

Figures are as of 10 November 2026.

## The problems

### Input is validated by hand in every route

There are about 850 routes, and each one checks its input with its own chain of `validateX(...)` / `if (!x.ok) return
err(...)`. The offer-create route (`domains/recruitment/offers/index.mjs`) spends about 40 lines on this before it does
any work. Writing it by hand is how the "non-text input" defects in [`known-issues.md`](known-issues.md) happen
(`.trim()` on a non-string, `String(obj)` turning an object into text), and new routes will keep adding more.

### Domains get everything through wide context objects

`server.mjs` is 1,700 lines. The club workspace context carries about 60 named dependencies, and
`registerRecruitmentRooms` takes about 40. Every domain can reach nearly everything, so the domain boundaries are
folder names rather than contracts. The import graph shows it: recruitment → discovery → verification → recruitment,
agents ↔ verification, and `domains/platform/`, the base layer, imports from `agents`, `development` and
`recruitment`.

### Transaction and side-effect rules are conventions only

The rules in [`architecture.md`](architecture.md#writes) are right, but nothing enforces them. Several known defects
are the same mistake: a multi-row write outside `unitOfWork`, or a notification sent before commit (decision drafts,
the transaction handoff, offer sharing, the Film Room feed).

### Two write styles

About 12 of the 42 repositories still use whole-record `update(id, (draft) => …)`; the rest use named acts. The
"Writes" section of `architecture.md` has become largely a list of exceptions as a result.

### No static types

About 120k lines of `.mjs`, with no type checking. A misspelled or renamed dependency or field reaches the code as
`undefined` and fails only on the path that uses it. The wide context objects make this worse.

### Very large files

Several repositories and route modules are 2,000–3,000 lines (agent compliance and transactions, signings,
`repositories/identity.mjs`). Splitting them along the lines the other improvements draw is cheaper than splitting them
on their own.

## The plan, in order

### 1. A shared input-schema layer

Each route declares the shape of its body, query and params once; a shared layer in `domains/platform/` checks it and
refuses bad input with the existing codes (`400 FIELD_INVALID` naming the field, or the domain's own code), never
coercing. The schemas are written with [valibot](https://valibot.dev), chosen because it is small (no dependencies of
its own, and only the functions a route uses are loaded) and because its schemas also produce TypeScript types
(`v.InferOutput`), so this work becomes the request types in step 5 rather than being repeated there.

- Request bodies are `v.strictObject`, so unknown keys are refused: an allowlist on the way in, as responses are on
  the way out.
- No coercing or transforming actions (`v.transform`, `v.toNumber` and similar): input is valid as sent or refused.
- Valibot's issues, with their field paths, are mapped to the existing error codes in one place in
  `domains/platform/`.
- Shape and type checks live in the schema; checks that span fields or need stored data (an expiry after now, a
  document belonging to this case) stay in the route or the repository.
- Shared schemas (dates, ids, money, free text with its length limit) are defined once and imported, like the other
  shared rules.

Move routes over one domain at a time, fixing the input defects in `known-issues.md` as each domain moves.

### 2. Narrow, declared dependencies per domain

Each domain exports a factory that names the small set of things it needs (its own repository, other domains' read
interfaces, `unit`, `afterCommit`, `notify`, …) and returns what it offers to others. `server.mjs` becomes a short list
of those calls in dependency order. Remove the cycles in the import graph, and make `domains/platform/` depend on
nothing above it: the audit rows, room statuses and Box Cam eligibility it imports today should be handed to it by
their domains. Split the very large route modules along these lines.

### 3. Enforced write and side-effect rules

Turn the conventions into checks:

- `notify`, `broadcast`, mail and push refuse to run while a transaction is open, except through `afterCommit`.
- A test (or a guard in the store) flags a request that makes more than one repository write outside a unit.

Fix the defects these checks turn up.

### 4. Named acts everywhere

Move the remaining whole-record repositories to named acts, remove `update(id, draft)`, and rewrite the "Writes"
section of `architecture.md` as one rule rather than a rule and its exceptions.

### 5. TypeScript

Convert the server to TypeScript once steps 1–4 have settled the shapes that are worth typing: request input (from the
step 1 schemas), each domain's declared dependencies and interface (step 2), and the repositories' named acts (step 4).
Typing the code before those refactors would mean writing the types twice. Start with `repositories/` and
`domains/platform/`, then convert domain by domain, with `strict` on and `tsc --noEmit` in CI. Decide at the start
between a build step and running `.ts` directly with Node's type stripping, which affects the minimum Node version in
`runtime.mjs`.

## Until then

Steps 1–4 are made without a type checker, so the end-to-end batteries are the safety net: run `npm run e2e` on every
step, and move one domain at a time so that a failure points at a small change.
