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

Ten of the 42 repositories still used whole-record `update(id, (draft) => …)` before step 5; the rest used named
acts. The "Writes" section of `architecture.md` had become largely a list of exceptions as a result.

### No static types

About 120k lines of `.mjs`, with no type checking. A misspelled or renamed dependency or field reaches the code as
`undefined` and fails only on the path that uses it. The wide context objects make this worse.

### Very large files

Several repositories and route modules are 2,000–3,000 lines (agent compliance and transactions, signings,
`repositories/identity.mjs`). Splitting them along the lines the other improvements draw is cheaper than splitting them
on their own.

## The plan, in order

### 1. A shared input-schema layer [**done**]

Each route declares the shape of its body, query and params once; a shared layer in `domains/platform/` checks it and
refuses bad input with the existing codes (`400 FIELD_INVALID` naming the field, or the domain's own code), never
coercing. The schemas are written with [valibot](https://valibot.dev), chosen because it is small (no dependencies of
its own, and only the functions a route uses are loaded) and because its schemas also produce TypeScript types
(`v.InferOutput`), so this work becomes the request types in step 5 rather than being repeated there.

- Request bodies are `v.strictObject`, so unknown keys are refused: an allowlist on the way in, as responses are on
  the way out.
- No coercing or transforming actions (`v.transform`, `v.toNumber` and similar): input is valid as sent or refused.
- Valibot's issues, with their field paths, are mapped to the existing error codes in one place in
  `domains/platform/`. A refusal carries a machine-readable `problem` and the values it needs (`max`, `allowed`, …);
  its English `message` is for developers. Wording for people belongs to the clients (step 7).
- Shape and type checks live in the schema; checks that span fields or need stored data (an expiry after now, a
  document belonging to this case) stay in the route or the repository.
- Shared schemas (dates, ids, money, free text with its length limit) are defined once and imported, like the other
  shared rules.

Every domain has moved, the platform layer's own routes with them, and the hand-written helpers
(`domains/platform/input.mjs`) are gone. A list sent where any schema expects an object, at any depth, is refused in
the shared layer (valibot reads `[]` as an object with no fields). New routes declare their input the same way.

### 2. Enforced write and side-effect rules [**done**]

The conventions are checks now (`writeRules.mjs`, described in [`architecture.md`](architecture.md#writes)):

- Mail, push and live events refuse to leave the process while a transaction is open. `notify` is not one of them:
  its row is part of the act, written in the act's unit, and only its push and live event wait for the commit.
- A request that commits a second transaction that changed rows, a GET that writes, and a write with no transaction
  open are refused outside production (so a battery fails at the call site) and counted in production.

Every route the batteries reach was moved onto one unit, with its notifications, ledger rows and audit events written
inside it; `sideEffectRunner` / `safe()` is gone, and `afterCommit` is the one place a failure never undoes the act.
The reads that still reconcile workflow state are declared and listed in [`known-issues.md`](known-issues.md).

### 3. Behavioural tests instead of source scans [**done**]

No battery reads server or app source any more. Each scan was replaced by a test of the behaviour it stood for, or
removed when it described only how the code was laid out (a store name the SQLite migration retired, a word that
must not appear, a file that must exist):

- **Trusted facts in the body**: sent alongside a valid body to every Offer route, each is refused by name.
- **One writer**: the writer's own fault seam fails the act and every row it touches is checked unchanged. A seam can
  also count without failing (`internal:STEP:0`, read back with `GET /__faults`), which shows that every status move of
  a full journey went through the one lifecycle writer.
- **Another domain's state**: what the other domain holds is read before and after (a club's cases and signings,
  every player's contract status and Trust Profile) and compared. This found that a completed signing does move the
  Trust Score, through the club history and squad row the Passport and Trust read; the test now says so.
- **Rate budgets**: `GET /__rate-limits` shows which budget a request drew on and under whose key.
- **Registries**: an undeclared live event was already refused where it is broadcast; a notification type with no
  category is now refused where it is sent. The hand-kept `EMITTED_EVENTS` list is gone.
- **Raw HTML in the apps**: Biome's `noDangerouslySetInnerHtml` runs in CI over every app file.
- **Ports**: every suite draws its port through `pickPort` with the offsets it boots on.

The development-only reads are refused in production with `/__faults`. Shared battery helpers are in `e2e/support/`.
The app promises the scans used to check, which need a test runner in the web apps, are listed in
[`known-issues.md`](known-issues.md).

### 4. Narrow, declared dependencies per domain [**done**]

Each domain exports a factory that names the small set of things it needs (its own repository, other domains' read
interfaces, `unit`, `afterCommit`, `notify`, …) and returns what it offers to others. `server.mjs` becomes a short list
of those calls in dependency order. Remove the cycles in the import graph, and make `domains/platform/` depend on
nothing above it: the audit rows, room statuses and Box Cam eligibility it imports today should be handed to it by
their domains. Split the very large route modules along these lines.

The import rules are in place and checked in CI ([`architecture.md`](architecture.md#domain-boundaries)): the domains
sit in layers, a domain imports a lower one only through its `public.mjs`, the platform layer imports no domain, and
there are no import cycles. The Football Passport and the Trust Score are their own domain (`domains/passport/`) at
the top, since they are projections over every other domain's records. Every domain is created by factories in its
`index.mjs` that name their dependencies (`domains/platform/deps.mjs`), and `server.mjs` passes each one by name with
no shared context; each domain's sweep is returned and scheduled there. The very large route modules (agent
compliance and transactions, signings, organisation verification) are split into a module per lane or group of
routes, composed in their old route order through one strict context, with what the parts share in a `shared.mjs`.

### 5. Named acts everywhere [**done**]

Every repository writes through named acts, and `update(id, draft)` is gone, along with the other edits of a copy
written back (`passportPrefs.save(playerId, change)`, the Development Hub's `update(id, () => record)`). A record is
created whole, then changes only through acts named after what happened, each refused unless the record is in a state
it moves from; the "Writes" section of [`architecture.md`](architecture.md#writes) is now one rule. The acts of the
repositories that still type records in JavaScript (discovery, development, passport, the scouting and opportunity
repositories) type the record with the fields they set before writing it; moving those to "reads back as written", as
the other repositories do, is a pass of its own.

No domain is handed another domain's repository to write through. Each owner offers named seams, created first in
`server.mjs`, and every other domain gets the owner's reads (`players.reads`, `users.reads`, `sessions.reads`,
`clubSetup.reads`, `recruitment.reads`, …) plus the seams it uses:

- **Identity**: `playerRecord` (a signing, the player's level and availability, the programme, stats, badges,
  attendance, media, medical sharing, location, timeline, external ids and notification preferences),
  `guardianRecord` (notification preferences), `orgRecord` (standing, suspension, the verification route's
  registration and revocation, the provisioned password, the lead MFA policy), `staffRecord` (joining, coming back,
  e-mail, SSO, delivery preferences, the second factor, removal) and `sessionEnds`. No other domain creates, erases or
  signs in a player, or changes a staff member's role.
- **Scouting**: `scoutingActs` (joining a squad, a grassroots club's squad entries and looking-for list, the
  federation request, an application's reminder).
- **Recruitment**: `recruitmentActs` (a safeguarding suspension of pending requests, a trial's report reminder, the
  follow-up sweep's escalation and reminders) and `caseHandoffs`.
- **Verification**: `coachReferences` (adding, publishing, revoking and withdrawing a coach reference).

The trial day (its staff and their checks, arrival, check-in, consent, the emergency contact and the day's status) is
part of the trial record, so its routes are recruitment's (`domains/recruitment/trialDay.mjs`): a postponement moves
the trial's date and report deadline, and a check-in records the session's attendance.

The tables that were left over from the move to SQLite each have their owner's repository: `uploadSessions` (media),
`savedSearches` (discovery), `invoices` and `reputationSeed` (recruitment) and `deliveryBookkeeping` (messaging). One
migration (`0038`) still creates them all.

The safety audit log (`safetyAudit.record`) is written by every domain and is the platform's, not a domain's.

### 6. TypeScript

Convert the server to TypeScript once steps 1–5 have settled the shapes that are worth typing: request input (from the
step 1 schemas), each domain's declared dependencies and interface (step 4), and the repositories' named acts (step 5).
Typing the code before those refactors would mean writing the types twice. Start with `repositories/` and
`domains/platform/`, then convert domain by domain, with `strict` on and `tsc --noEmit` in CI. Decide at the start
between a build step and running `.ts` directly with Node's type stripping, which affects the minimum Node version in
`runtime.mjs`.

Group the domain factories' dependencies as the types are written, so each signature changes once:

- **One platform object.** `unit`, `nextId`, `notify`, `broadcast`, `byId`, `findPlayer`, `isBlocked`, `rateLimit`
  and `ledgerAppend` are passed to nearly every factory, about a hundred lines of `server.mjs`. They are the platform
  layer's services and should be one typed dependency (`platform.unit`, `platform.notify`, …).
- **One interface object per domain.** A factory should receive what another domain offers as one object (`passport`,
  `rooms`, `development`) instead of its functions one by one (`assemblePassport: passportDomain.assemblePassport`,
  …). The largest factories take 35–55 names today; most of those are pieces of a few domains' interfaces, and the
  grouped objects are what the types describe.

### 7. Error wording in the clients

Independent of steps 1–6, and frontend work. About a hundred places in the apps show the server's `message` directly
(`notify(e.message)`), so people read developer English, untranslated. Add one shared client helper that turns a
refusal's `error`, `field`, `problem` and values into a sentence from the app's translations, with screens giving
their own field labels and wording for the codes that need it (as the offer panel already does with `of.err.<code>`).
Write it so it can move to a shared package, and move the screens over to it one app at a time.

## Until then

Steps 1–5 are made without a type checker, so the end-to-end batteries are the safety net: run `npm run e2e` on every
step, and move one domain at a time so that a failure points at a small change.
