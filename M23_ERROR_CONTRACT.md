# M23 — The Lifecycle and Journey Error Contract

> Every domain error M23 can produce, the HTTP status it answers with, what a
> viewer may see, and what stays in the log.

The table is not this document. The table is
`scoutbox-server/m23/errors.mjs`, and `m23E2E` group **Y** checks this
document's claims against it and against a running server. What follows
explains the table; it does not define it.

---

## 1. Why there is a table at all

There were two ternary chains, one per route, and each ended in a default:

```js
const code = verdict.error === 'LIFECYCLE_NOT_PERMITTED' ? 403
  : CONFLICT.includes(verdict.error) ? 409
    : verdict.error === 'LIFECYCLE_EVIDENCE_REQUIRED' ? 422
      : verdict.error === 'LIFECYCLE_STATE_UNKNOWN' ? 500
        : 400;                                        // ← the problem
```

A default is indistinguishable from a decision. A code added to the validator
later inherits `400` silently, and `400` means "your request is malformed" —
which, for a case that is simply in the wrong state, sends the caller to fix
something that was never broken. Two codes were already arriving at their
status that way: `LIFECYCLE_REASON_REQUIRED` (correctly, by luck) and
`LIFECYCLE_CASE_NOT_A_ROOM` (wrongly).

Now: one table, no default. `httpStatusFor` returns `null` for a code it has
never been told about, the route answers 500 **and logs the code by name**, and
`m23E2E` fails before that can ship.

## 2. The bands

| Status | Means | Who fixes it |
|---:|---|---|
| **400** | the request is wrong | the caller, by changing the request |
| **403** | not yours to do, in any state | nobody — the role is the answer |
| **404** | not visible to you | nobody, deliberately (see §4) |
| **409** | the request is fine; the **case** is not where you thought | the caller, by reloading |
| **422** | request and case are fine; the **evidence** is not there | whoever records the evidence |
| **500** | this build, or its data, is wrong | us |

The 400/409 split is the one that carries weight. `400` tells a client "look at
what you sent". For `LIFECYCLE_TRANSITION_INVALID` there is nothing in the
request to look at — the body was well-formed and the action was permitted; the
case had simply moved. `409` sends them to reload, which is the action that
actually helps.

## 3. The contract

`may expose existence?` — whether receiving this error tells the caller that
the case id is real. Every `no` in that column is load-bearing.

### 400 — the caller can fix it

| code | meaning | viewer-safe message | exposes existence? | log detail |
|---|---|---|---|---|
| `LIFECYCLE_STAGE_NOT_SETTABLE` | client sent `stage`/`status` instead of naming an action | "The recruitment stage is not settable directly. Name a recruitment action instead." | yes — caller already sees the room | none needed |
| `LIFECYCLE_ACTION_UNKNOWN` | no such action | "Unknown recruitment action." + the action list | yes | none needed |
| `LIFECYCLE_REASONS_INVALID` | reasons not a list, or an element not a string | "Reasons must be a list of lifecycle reason codes." | yes | none needed |
| `LIFECYCLE_REASONS_TOO_MANY` | more than the cap | "Record up to N reasons." | yes | none needed |
| `LIFECYCLE_REASON_UNKNOWN` | a code outside the 16 — typically an M17 **decision** code | names the lifecycle taxonomy | yes | none needed |
| `LIFECYCLE_REASON_REQUIRED` | an ending action with no reason | "Ending a recruitment case requires a recorded reason." | yes | none needed |
| `ROOM_REASON_PROHIBITED` | a protected characteristic offered as a reason | M17's message, shared deliberately | yes | **yes** — worth an operator's attention |

`ROOM_REASON_PROHIBITED` keeps M17's code on purpose. A protected
characteristic can never be a reason for anything, and that rule must not have
two implementations that can drift apart.

### 403 — not yours

| code | meaning | viewer-safe message | exposes existence? | log detail |
|---|---|---|---|---|
| `LIFECYCLE_NOT_PERMITTED` | the role may not take this action, in any state | "Your role cannot take this recruitment action." | yes — the caller can already see the room | none needed |

Reached only *after* `findRoomForRequest`, so the caller has already passed the
room's visibility gate, including the restricted-room check. A 403 here
therefore discloses nothing a 200 would not have.

### 404 — concealment

| code | meaning | viewer-safe message | exposes existence? | log detail |
|---|---|---|---|---|
| `CASE_NOT_FOUND` | no such case, **or** another organisation's case | "No such recruitment case." | **no** | none |
| `CASE_NOT_A_ROOM` | the case exists but has no workspace | "This recruitment case has no workspace." | **no** | none |
| `LIFECYCLE_CASE_NOT_A_ROOM` | the same, raised by the validator | "This recruitment case has no workspace to move." | **no** | none |

### 409 — the case moved

| code | meaning | viewer-safe message | exposes existence? | log detail |
|---|---|---|---|---|
| `LIFECYCLE_TRANSITION_INVALID` | no edge from here to there | names both states, plus `allowed` | yes | none needed |
| `LIFECYCLE_NO_CHANGE` | already in that state | "The case is already in that state." + `allowed` | yes | none needed |
| `LIFECYCLE_ACTION_NOT_APPLICABLE` | the edge exists; this action does not describe it | names action and state | yes | none needed |
| `ROOM_VERSION_CONFLICT` | someone else moved it first | M18.1's shared conflict notice | yes | none needed |

`ROOM_VERSION_CONFLICT` is **M18.1's contract, not M23's**. It is raised by
`guardRev` before M23's mapping is reached, and its body — `expectedRev`,
`currentRev`, `updatedBy`, `updatedAt` — is what `conflict.tsx` renders in two
clients across five milestones. `updatedBy` is a display name and never a user
id. M23 must not widen it and does not: `Y11c` asserts the 409 body is exactly
that contract, and `Y11d` that it carries no lifecycle reason code and no
narrative field.

### 422 — the evidence is not there

| code | meaning | viewer-safe message | exposes existence? | log detail |
|---|---|---|---|---|
| `LIFECYCLE_EVIDENCE_REQUIRED` | the target status needs a durable record that is absent | names the requirement, plus `requires` and `evidenceReason` | yes | none needed |

`requires` is an evidence **kind** — `confirmed_join`, `contact_delivered` —
never a record, an id or a person. `evidenceReason` is `not_implemented`,
`unsatisfied` or a named gap like `no_confirmed_join`. Both are kept
deliberately: a 422 whose entire job is "the record that would justify this is
missing" is useless if it will not say which record. Being honest in the
product about what a deployment cannot yet check is the same honesty M18.1's
capabilities surface already publishes.

### 500 — ours

| code | meaning | viewer-safe message | exposes existence? | log detail |
|---|---|---|---|---|
| `LIFECYCLE_STATE_UNKNOWN` | a **stored** status this build does not recognise | the fixed internal message | yes | **full** |
| `JOURNEY_STORE_MISSING` | a required collection is absent or is not a list | the fixed internal message | yes | **full** — `missing` and `malformed` by name |
| `CASE_HISTORY_CORRUPT` | `history` present and not an array | the fixed internal message | **no** — see below | **full** |
| `JOURNEY_VIEWER_UNKNOWN` | the projector was handed a viewer kind it does not know | the fixed internal message | yes | **full** |
| `LIFECYCLE_INTERNAL` | a code reached the router that the table has never heard of | the fixed internal message | yes | **full**, including the unmapped code |

Every 500 answers with the same fixed body:

```json
{ "ok": false, "error": "<CODE>",
  "message": "The recruitment journey cannot be served for this case. This has been recorded." }
```

The code survives so a client can branch and a log can group. **Everything
else does not.** `JOURNEY_STORE_MISSING` is the reason this matters: internally
it carries `missing` and `malformed`, which are lists of **raw store names**.
That detail is exactly right in a unit test and in a server log, and it is the
internal schema handed to anyone who can provoke a 500. `Y7` asserts the
projector still names the stores; `Y8` asserts the body a client receives names
none of them.

`CASE_HISTORY_CORRUPT` sits **below** the concealment branches on purpose.
Telling a player "this case is corrupt" where a stranger is told "no such case"
confirms the case exists — corruption reporting must not become an existence
oracle.

`JOURNEY_VIEWER_UNKNOWN` answered **404** until this closure pass. That told a
caller "no such case" about a case that exists and is fine; the defect is in
whoever called the projector with an unknown viewer kind. It is unreachable
through the two routes, which always supply a known kind — so this is a
contract correction, not a behaviour change.

## 4. Hidden case, foreign case, absent case

Three different situations, one public answer:

```
GET /org/rooms/case-does-not-exist/journey   → 404 {"ok":false,"error":"CASE_NOT_FOUND","message":"No such recruitment case."}
GET /org/rooms/<another club's case>/journey → 404 {"ok":false,"error":"CASE_NOT_FOUND","message":"No such recruitment case."}
```

`Y12` asserts both are 404. `Y13` asserts the bodies are **byte-identical** —
not merely the same status, because a single differing character is an oracle,
and because centralising the mapping is exactly the kind of change that could
have introduced one.

## 5. The drift guard

`m23E2E` group **Y**, and it is mechanical rather than a list somebody keeps:

| check | what it does |
|---|---|
| `Y1` | extracts every `error: 'CODE'` literal from the M23 source files themselves — 20 found |
| `Y2` | every extracted code has a status. No exception for `LIFECYCLE_INTERNAL`, the code that exists to report drift |
| `Y3` | the converse — no table entry that nothing can produce. `ROOM_VERSION_CONFLICT` is the one declared exception, because M18.1 raises it |
| `Y4` | an unknown code resolves to `null`, not to a default |
| `Y5` | `httpStatusFor('constructor')` is `null` — the table is null-prototype |
| `Y6` | every status is one of 400/403/404/409/422/500 |
| `Y7`–`Y10` | the internal/public split, with the control that proves it is not vacuous |
| `Y11`–`Y11d` | no field outside the published shape, and the one excluded body checked against §35 |
| `Y12`–`Y13` | hidden-case parity, byte for byte |

A hand-written list of codes here would pass forever while the module grew one
nobody mapped — which is precisely what the ternary chain did.

## 6. M23 P3 — the Contact codes (appended)

P3 extends the same table, under the same rule (no default branch), with
twenty-two `CONTACT_*` codes and one new band:

| band | codes |
|---|---|
| 400 | `CONTACT_CONTENT_INVALID`, `CONTACT_CONTENT_TOO_LONG`, `CONTACT_CLIENT_KEY_INVALID`, `CONTACT_REV_REQUIRED`, `CONTACT_CHANNEL_INVALID`, `CONTACT_OCCURRED_AT_INVALID`, `CONTACT_RECIPIENT_MISMATCH`, `CONTACT_ACTION_UNKNOWN`, `CONTACT_RESPONSE_INVALID` |
| 403 | `CONTACT_NOT_PERMITTED`, `CONTACT_BLOCKED` |
| 404 | `CONTACT_NOT_FOUND` (reached only after the room's own concealing lookup) |
| 409 | `CONTACT_INVALID_STATE`, `CONTACT_ALREADY_SENT`, `CONTACT_CASE_STATE`, `CONTACT_VERSION_CONFLICT`, `CONTACT_IDEMPOTENCY_CONFLICT` |
| 422 | `CONTACT_RECIPIENT_UNAVAILABLE`, `CONTACT_GUARDIAN_REQUIRED` |
| **429** | `CONTACT_COOLDOWN` — the deterministic per-recipient cooldown; the body carries `retryAt`, which joined the public field list. The limiter's own `RATE_LIMITED` stays outside the table, as before. |
| 500 | `CONTACT_STATE_UNKNOWN`, `CONTACT_STORE_MISSING` |

The mapping function moved from `m23/index.mjs` into `m23/errors.mjs` as
`sendDomainError`, so the lifecycle routes and the Contact routes share one
place where a code becomes a status. The drift guard grew with it: `Y1` also
matches the `err(res, 'CODE')` form and sweeps `errors.mjs` itself, `Y6`
admits 429, and the `EXTERNAL` set (codes raised by another module) lists
`CONTACT_VERSION_CONFLICT` beside `ROOM_VERSION_CONFLICT`. Hidden-case parity
(`Y12`/`Y13`) is asserted again for the Contact list, one-by-id, write and
send in `m23ContactE2E` R5–R5d.
