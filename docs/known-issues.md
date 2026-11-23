# Known issues

Problems accepted for now, to revisit before release.

## Password hashing is about 12 times slower than the TypeScript server's

Decided 2026-11-16: keep the pure-Gleam scrypt, and revisit closer to release.

**What it is.** Passwords are hashed with scrypt at Node's default parameters (N = 16384, r = 8, p = 1), the scheme
the TypeScript server uses, so stored hashes (`scrypt$<salt>$<hash>`) work on both servers. OTP's crypto has no
scrypt, so `scoutbox-server/src/scoutbox/platform/scrypt.gleam` implements it in pure Gleam, with no FFI or NIF.
It agrees with Node's `crypto.scryptSync` on every case in `test/fixtures/scrypt_cases.json`.

**The cost.** Measured with `gleam run -m scrypt_bench` on an M1 Pro with 6 schedulers:

- one hash takes **467 ms**, against Node's 38 ms;
- eight at once take 816 ms in all, each on its own scheduler;
- so a password sign-in takes about half a second, and the server handles about 13 a second at most.

Other requests aren't held up meanwhile: the BEAM preempts a long hash, and a 1 ms sleep took at most 3.9 ms while
eight hashes ran. Node's `scryptSync`, by contrast, blocks its only thread for every hash.

**Why it was accepted.** Password sign-ins are rare and rate-limited, so half a second is tolerable for now, and
staying with scrypt keeps the seed, fixtures and both servers on one scheme.

**Options when it's revisited.**

- **A NIF** (a C scrypt, or Argon2id): fast, and Argon2id is the strongest choice. But it brings C code into the VM
  and a C toolchain into the build.
- **PBKDF2-HMAC-SHA256**, which both OTP and Node have natively, with no dependencies. It isn't memory-hard, so it
  is weaker against GPU cracking than scrypt.

Switching scheme means changing both servers together (`adapters.mjs` `hashPassword`/`verifyPassword` in the
TypeScript tree) and regenerating the seed, whose Trust & Safety reviewer secrets are scrypt hashes. There is no
production data, so nothing needs rehashing.

## The journey's history lines never name who acted

Found 2026-11-16 while porting the recruitment journey. Ported as the TypeScript server behaves.

**What it is.** `GET /org/rooms/:id/journey` lists a case's history, and each line has a `by` field. For the case's
own entries (`room_created`, `room_status_changed`, `room_reopened`, `room_decision_recorded`, and the transaction
handoff entries), the TypeScript projector (`domains/recruitment/lifecycle/journey.mjs`, `timelineFor`) reads
`h.by?.name`. A case history entry has no `by` field, though: the repository reads it back as `byKind`, `byId` and
`byName` (`historyOut` in `repositories/recruitmentCases.ts`). So `by` is always null on those lines, even when the
entry records a named staff member. Decision, Offer and trial lines are unaffected: those records do carry `by`.

**Where it is in the port.** `scoutbox-server/src/scoutbox/recruitment/journey.gleam` writes `by: null` for those
lines, with a comment, so the batteries and `dev/shape_diff.mjs` agree with the TypeScript server.

**Fix.** Read `h.byName` in `timelineFor` on the TypeScript side, then name the actor in the Gleam projection too.
Check that no client or battery relies on the null first.


## Scouts' disagreement on an attribute is never suggested as an evidence gap

Found 2026-11-20 while auditing the `Not ported yet:` markers. Ported as the TypeScript server behaves.

**What it is.** The missing-evidence rule `assessment_disagreement` (`domains/insight/insight.mjs`) should fire when
two submitted reports rate one attribute two or more points apart. It reads each rating's `value`, but a rating's
field is `rating` (`repositories/scoutingAssessments.ts`), so every value is `undefined`, the spread is `NaN`, and
the rule never fires.

**Where it is in the port.** `scoutbox-server/src/scoutbox/insight/evidence_gaps.gleam` has no such rule, and its
module comment says why.

**Fix.** Read `r.rating` in the TypeScript rule, with a battery check that two split reports raise the
suggestion, then port the rule.


## An agent with no profile is told it needs a VERIFIED "undefined"

Found 2026-11-16 while porting the transaction workspace. Ported as the TypeScript server behaves.

**What it is.** `POST /org/agent/transactions` first runs the facet gate (`compliance.facetGateProblem`). For an
agent with no agent profile, the gate answers `{ error: 'AGENT_VERIFICATION_REQUIRED', message: 'Create your agent
profile first.' }`, with no facet fields. The route (`domains/agents/transactions/agentRoutes.mjs`) then replaces the
message with one built from `gate.facet`, `gate.memberAssociation` and `gate.state`. All three are undefined here,
so the agent reads:

> A regulated action needs a VERIFIED undefined; it is undefined.

The code (`AGENT_VERIFICATION_REQUIRED`, 403) is right; only the message is broken.

**Where it is in the port.** `gate_refusal` in `scoutbox-server/src/scoutbox/agents/transaction_routes.gleam`
sends the same text for `compliance_store.NoProfile`, with a comment.

**Fix.** In `agentRoutes.mjs`, keep the gate's own message when it names no facet ("Create your agent profile
first."), then send that text from `gate_refusal` too. No battery checks this message.

## A policy version's rules are ordered by the keys of a JSON object

Found 2026-11-18 while porting the policy routes. Ported as the TypeScript server behaves.

**What it is.** `POST /ts/compliance/policies` takes a version's rules as an object keyed by rule id
(`{ "FIFA-8.1": {…}, "FIFA-11.1": {…} }`). The TypeScript server stores each rule's position in the order the keys
were sent (`Object.entries` in `writeRules`, `repositories/compliancePolicies.mjs`), and the policy view returns
`rules` in that order. The admin app renders its rules table straight from it (`Object.entries(p.rules)` in
`scoutbox-admin/src/m25tabs.tsx`). But JSON object members have no order: the standard says so, and a proxy or a
client library may reorder them. The order a Trust & Safety administrator entered is kept only by luck.

**Where it is in the port.** An Erlang map has no order either, so this server reads the order keys were sent in
from the request's raw text (`scoutbox-server/src/scoutbox/platform/key_order.gleam`) and `input` keeps it.

**Fix.** Send and return rules as an array, each carrying its id (`rules: [{ "ruleId": "FIFA-8.1", … }]`), so the
order is part of the data. That changes the TypeScript server, the admin app, the batteries and this server
together, so it waits until the port is done.

## A list is accepted as a segment's drawing, or a template's anchors

Found 2026-11-18 while porting video segments. Ported as the TypeScript server behaves.

**What it is.** `POST /org/media/:id/segments` takes an optional `drawing`, documented as an object of overlay
shapes. Its schema (`domains/scouting/scouting.mjs`) is valibot's `record`, which also accepts a list and turns it
into an object keyed by index, so `drawing: [{…}, 3]` is stored and returned as `{ "0": {…}, "1": 3 }`. The schema's
own `!Array.isArray` check sees the converted object, so it never refuses a list. A template's `anchors` are read
the same way, but there a list always fails the levels check (`"0"` isn't a level), so it is only refused with
`invalid` rather than `not_object`.

**Where it is in the port.** `input.record` (`scoutbox-server/src/scoutbox/platform/input.gleam`) reads a list as
valibot does, and both routes use it.

**Fix.** Refuse a list before the record check (`v.pipe(v.custom((d) => !Array.isArray(d)), v.record(…))`), and use
`input.entries` here. No battery sends a list.

## A training slot "falls inside" the player's available times when it only overlaps them

Found 2026-11-19 while porting suitability. Ported as the TypeScript server behaves.

**What it is.** `GET /player/suitability/:oppId` (and the guardian's view of it) answers `compatible` for the
schedule, with the reason "every published training slot falls inside your available times", when every training slot
*overlaps* one of the player's available slots (`domains/scouting/suitability.mjs`, through `slotsOverlap`). A
player free on Tuesday 17:00–17:30 is told that Tuesday training from 17:00 to 20:00 fits. The same verdict goes into
the summary a club sees once the player shares it.

**Where it is in the port.** `scoutbox-server/src/scoutbox/scouting/suitability.gleam`, `schedule`, uses the same
overlap test.

**Fix.** Test containment for availability (each training slot within one available slot), keeping overlap for
commitments, on both servers. The `clubOperations` battery's check uses a slot that is contained, so it would still
pass.

## A reconnecting stream is replayed events the registry says are never replayed

Found 2026-11-20 while porting the live events. Ported as the TypeScript server behaves.

**What it is.** Each event in the registry (`domains/platform/eventRegistry.mjs`) has a `replayPolicy`, and 45 of
them say `never`: the agent and compliance events, the trial invitations and schedule changes, a Room's decisions and
handoffs, a draft Offer's edits. But the reconnect log in `domains/platform/liveSync.mjs` keeps every event except
`typing`, so a client that reconnects with a `lastEventId` is sent those events again. Nothing reads `replayPolicy`
except the tests that check each entry has one.

**Where it is in the port.** `scoutbox-server/src/scoutbox/platform/live_event.gleam`, `replays`, keeps every event
but typing too. Until 2026-11-20 this server honoured `replayPolicy`.

**Fix.** Keep only `replay` events in the log, on both servers. A client sees no difference beyond fewer stale
nudges after a reconnect, since every event is only a cue to refetch.

## A directory text search reads every player the club can see

Found 2026-11-21 while porting the directory search. Accepted for now; it should be fixed before the player table
grows.

**What it is.** The TypeScript server matches a search against the lowered name, country and city in SQL, through a
function it adds to SQLite (`lower_js`, JavaScript's `toLowerCase`, accented letters included). SQLite's own `lower()`
lowers A–Z only, and esqlite gives no way to add an SQL function written in Gleam or Erlang. So `directory_page`
(`scoutbox-server/src/scoutbox/discovery/directory.gleam`) runs the directory's query without the text condition and
without a row limit, decodes every admitted player past the cursor, and matches each one in Gleam with
`platform/js_text.lower`. Results, order and cursors match TypeScript's (120 searches compared).

**The cost.** For a pro club the admitted players are nearly the whole `players` table, read and decoded on every
search, and again from each next page's cursor. TypeScript scans the table too, since no index helps `instr`, but its
scan stays inside SQLite and stops after `limit + 1` matches. This server reads past that point. A common search term
therefore costs a whole-table read here where it costs a short scan there. With the seed's handful of players nobody
notices; with tens of thousands it would mean slow searches and a burst of memory on every request.

**The fix to aim for.** Register a deterministic `lower_js` scalar function on each connection from C, in the esqlite
patch (`vendor/esqlite.patch`), backed by a Unicode lowercase table generated at build time (OTP's or the Unicode
Character Database's), with JavaScript's Final_Sigma rule. The query can then be TypeScript's, filtered and limited in
SQL. The same function would let the foot criterion (matching, watchlists, Nobody Missed) use `lower_js` as
TypeScript does instead of `lower()`. Every stored foot is ASCII today, so that case is harmless. Test the C function
against Node's `toLowerCase`, as `test/scoutbox/platform/js_text_test.gleam` tests `js_text.lower`.

**Until then.** A cheaper stopgap is to scan in batches of a few hundred by the keyset cursor and stop at
`limit + 1` matches. That brings the common case back in line with TypeScript, though a rare term still reads the
whole table. A pre-filter with SQLite's `lower()` isn't safe: JavaScript lowers "İ" to "i" plus a combining dot,
and the Kelvin sign to "k", so it would drop rows that should match.

## Reputation shows every club the whole ledger's activity, players' names included

Found 2026-11-22 while porting `/org/reputation`. Ported as the TypeScript server behaves.

**What it is.** `GET /org/reputation` (TypeScript's `domains/recruitment/ledger.mjs`) answers any club's staff with a
`live` row for every actor name and organisation name pair on the whole ledger (`countsByActor`), not only its own.
Each row gives that pair's counts of profile views, contact requests, trial requests and reports, and signings.
Any club can therefore see how many players each rival club's scouts have viewed, contacted, trialled and signed.

The rows aren't limited to staff, either. Every ledger type opens a row, and some rows name someone who isn't
staff: a message records its sender, so a player who messages a club appears as a "scout" of that club, with all
counts zero. After a `platform/api` run against the TypeScript server, the live rows include
`Kola Adeyemi · Eastport FC` (a player's message), `system · ScoutBox` and `open day` beside the scouts. The same would
show a minor's name, or a guardian's, once they message a club. That tells every club that the player is talking to
that one.

**Where it is in the port.** `request_routes.reputation` and `ledger.counts_by_actor`
(`scoutbox-server/src/scoutbox/recruitment/request_routes.gleam`, `safety/ledger.gleam`) read the whole ledger and
open a row for every type, as TypeScript does. `platform/api` RP2 specifies that behaviour.

**Fix.** Decide what reputation is meant to show, then change both servers and RP2 together. The likely answer is
the club's own scouts only (`org_id` = the caller's), counting only staff acts (`user_id IS NOT NULL`). If rivals'
track records are meant to be visible, still drop every row with no staff member, and confirm with the Founder that
clubs may see each other's activity counts. The club and grassroots portals read the endpoint (`getReputation`), so
check what their screens assume first.

## Expo's answers are never read, so dead device tokens are never pruned

Found 2026-11-23 while porting the Expo push transport. Ported as the TypeScript server behaves.

**What it is.** With `EXPO_ACCESS_TOKEN` set, a push makes one `POST /--/api/v2/push/send` per device token the
player or guardian registered (`push.deliver`, `scoutbox-server/src/scoutbox/messaging/push.gleam`; `adapters.mjs`
`createPushSender` in the TypeScript tree). It ignores what Expo answers:

- **Tickets.** Expo answers each message with a ticket. A ticket can say the token is dead (`DeviceNotRegistered`,
  after the app was uninstalled or its token rotated), but the token stays in `push_tokens`, so every later push to
  that person still calls Expo for it.
- **Receipts.** Whether Apple or Google actually delivered a message comes from a later call to Expo's receipts
  endpoint, made with the ticket ids. It is never made, so a delivery failure is never seen. `push_log` only
  records that a push was asked for.
- **Batching.** Expo takes up to 100 messages in one call. The server makes one call per token. It costs nothing
  (Expo is free), but it means more requests and more pressure on Expo's rate limit as volume grows.

**Why it was accepted.** At pilot volume a few wasted calls cost nothing, and staying with the TypeScript server's
behaviour kept the port to parity.

**Fix.** In this order:

1. Read the tickets. Delete the token whose ticket says `DeviceNotRegistered`, and log any other error.
2. Send in batches of up to 100, so one call covers every token of a push, or several pushes in a sweep.
3. If delivery needs to be known, store the ticket ids and have a sweep fetch their receipts about 15 minutes
   later, pruning tokens the same way.

The first two need no schema change. The third needs somewhere to keep ticket ids, either on `push_log` or in a
table of their own.

## Revisit these questions

### A close can beat the completion of a fully signed package

Decided 2026-11-17 while porting `recruitment/journeyAdversarial`: the battery was loosened at source
(`40d1c23f` in the TypeScript tree) so the port isn't held up. G6 had assumed the single thread's winner, which is
the request sent first. On the BEAM either request can win.

**What it is.** Section B12 completes a package that both parties have signed while a `closeCase` races it, and
already accepted either outcome. If the close wins, the case closes with both signatures on a READY package and no
signing row, and B12 reopens it. G6 used to require the completed case's stage, and now accepts `review` when no
package completed.

**The question.** Should a close be refused while a package has every signature it needs, or while a signing is in
progress? That is a product rule the single thread hid, since the completion always won there.

### The policy view leaves out a rule's overrides and its own start date

Found 2026-11-18 while porting `agents/compliancePersistence`. Ported as the TypeScript server behaves.

**What it is.** `GET /ts/compliance/policies` (and the agent's and admin's policy lists, which share the view) gives
each rule five fields: `ruleStatus`, `textStatus`, `note`, `params` and `sourceRef` (`policyPublic` in
`domains/agents/compliance/policyRoutes.mjs`). A rule can also carry `overrides`, which name the national rule that
takes its place in a jurisdiction (FIFA-12.8, 12.9 and 12.10 give way to ENG-6.3, 6.4 and 6.5), and its own
`effectiveFrom` (FIFA-RSTP-2027 applies from 1 January 2027). Both are stored, the conflict engine and the policy
rules use them, and `POST /ts/compliance/policies` accepts them, but no view returns them. So a Trust & Safety
reviewer can't see why a FIFA rule doesn't decide an England case, and an administrator who submits a version
can't check what was stored. `scoutbox-server/src/scoutbox/agents/policy_routes.gleam` returns the same five fields.

**The question.** Should the view return `overrides` and a rule's `effectiveFrom`? If it should, change both servers
together and check the admin app's rules table first. If they were left out on purpose, say why in the view.
`agents/compliancePersistence` compares the seeded rules with the snapshot through the stored rows, because the view
doesn't carry them whole.

### A transition pack shows evidence without what it is

Found 2026-11-19 while porting `operations/clubOperations`. Ported as the TypeScript server behaves.

**What it is.** When a club opens a transition pack (`GET /org/transitions/:id/pack`), each evidence record is meant
to show its `kind`, `tier` and `summary` (`packView` in `domains/verification/transitions.mjs`). An evidence record
has none of those fields: it has `claimType`, `label`, `value` and a verification tier under `verification`. So the
club sees only each record's `id` and `recordedAt`, and can't tell what the player chose to share.
`scoutbox-server/src/scoutbox/verification/transitions.gleam` sends the same two fields.

**The question.** Which of the record's fields should a receiving club see? Probably the claim type, label, value
and verification status, since those are what the player's own Passport shows. Change both servers together.

### Some requests are no longer counted in the request metrics

Decided 2026-11-20 while porting `platform/contracts`: match the TypeScript server for now, and decide once the port
is done.

**What it is.** The request instrumentation (`scoutbox-server/src/scoutbox/platform/instrument.gleam`) stands where
the TypeScript server's `requestInstrumentation` does, after CORS, the HTTP baseline and the fault layer. So three
kinds of answer get no correlation id, no log line, and no count in `/admin/metrics`: a CORS preflight, a simulated
fault, and a refusal of a body that couldn't be read (`413 REQUEST_TOO_LARGE`, `400 MALFORMED_JSON`). Until this
change the Gleam server counted every request. The TypeScript server misses these only because Express parses the
body, and runs the fault layer, before its instrumentation.

**The question.** Should `/admin/metrics` count every request? An operator watching for abuse would want to see a
burst of oversized or malformed bodies, and a 4xx rate that leaves them out understates it. If it should, change
both servers together: in TypeScript, install the instrumentation before the body parser and the fault layer.
