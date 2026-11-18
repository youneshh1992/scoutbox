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
