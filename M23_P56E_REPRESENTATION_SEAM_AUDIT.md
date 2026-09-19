# M23 P5.6E — Representation seam audit

Produced before any integration code, per §4. Every claim below was read out of
the code at `6d3401b`, not taken from a comment.

## 1. The two lanes

ScoutBox has **two** representation lanes. They are not equivalent and only one
is authoritative.

### Lane A — canonical (P5.6B), authoritative

| | |
| --- | --- |
| Store | `db.representationAgreements` (+ `db.agencyAffiliations`, `db.agentProfiles`) |
| Created by | `POST /org/agent/clients/request` — a **licensed_agent** only |
| Confirmed by | `POST /player/agent/relationships/:id/confirm` — the client |
| Names | a natural-person agent (`agentUserId`) AND an agency (`agencyOrgId`) |
| Carries | scope[], jurisdiction, term, exclusivity, status, rev, idempotency keys, history |
| Access predicate | `agreementGrantsAccess(a, agentUserId)` in `m24/shared.mjs` |
| Read by | scoutbox-agent (all client surfaces), player My Agent, P5.6C compliance, P5.6D transactions |

The predicate, verbatim in effect: a row grants private client access only if
`typeof a.agentUserId === 'string'` and non-empty, equals the caller, `confirmedAt`
is set, and `effectiveAgreementStatus(a, now) === 'active'`. Nothing else — not a
proposal, not a dispute, not a colleague's agreement, not agency membership.

### Lane B — legacy M13 F10, historical

| | |
| --- | --- |
| Store | `db.representations` (declared in `m13/shared.mjs:17`, "F10 — adult representation relationships") |
| Created by | `POST /org/representation/propose` in `m13/transitions.mjs:238` — **any user of any org whose `type === 'agency'`** |
| Confirmed by | `POST /player/representation/:id/confirm` — the player |
| Names | an agency and a free-text `representativeName`. **No natural-person agent id.** |
| Carries | scope as a single string, `credential` note, status, no rev, no idempotency |
| Status freshness | computed at read time by `repFresh(r)`; the stored `status` is never updated on expiry |

What Lane B does **not** do: no licence requirement, no verification facet check,
no jurisdiction policy, no conflict evaluation, no consent ledger, no minor gate
beyond an adult wall, no rev, no idempotency, no compliance context.

## 2. Who reads Lane B today

| Reader | What it does | Verdict |
| --- | --- | --- |
| `m162/trust.mjs:89` | relationship evidence input | **Correct.** Requires `confirmedAt`, `status === 'active'` and not past `endAt`. This is the P5.6A `D-P56A-1` fix. §13 requires this to be permanently regression-guarded. |
| `m15/passport.mjs:127` | `db.representations.filter(r => r.playerId === pid && r.confirmedAt)` → the Passport bundle | **Defective.** `confirmedAt` survives withdrawal, dispute and expiry. |
| `m15/shared.mjs:460` `currentStatus` | `representations.find(r => r.status === 'active')` → `status.representation` on the club-facing Passport | **Defective.** Uses the **stored** status, so a row whose `endAt` has passed still reads `'active'` and is presented as the player's current representation. Lane B itself computes `repFresh` at read time precisely because the stored status goes stale. |
| `m15/shared.mjs:327` `buildTimeline` | `representation_started` / `representation_ended`, `visibility: 'recruitment'` | Correct — the ended entry covers withdrawal and expiry. |
| `m14/shared.mjs:544` | one-time claim migration: an F10 `credential` becomes a **pending** LICENCE claim with `document_submitted` | Correct — no false upgrade to verified. |
| `m182/migrations.mjs:424` (step 2305) | one-time mirror of every F10 row into `representationAgreements` with `agentUserId: null` | Safe **by the predicate** — a null agent can never match a caller — but see §4 below. |
| `scoutbox-club` / `scoutbox-grassroots` `m13screens.tsx:528` | agency "Representation" screen: list + **propose** | Live legacy writer surface. |
| `scoutbox-player` `M13Sections.tsx:213` | player confirm / withdraw / dispute | Live legacy actor surface. |
| `scoutbox-admin` `m13tabs.tsx:87` | T&S credential document review | Read + credential review only. |

The canonical lane is **not** read by the Passport at all. The Passport's
representation headline is driven entirely by Lane B — so the system's most
widely-read player projection is blind to the authoritative source. That is an
integration gap P5.6E must close, not merely a defect.

## 3. Findings (defect candidates, all inherited)

**E-1 — the legacy writer is a second active authority writer (High, inherited).**
`POST /org/representation/propose` lets any member of any agency-typed org create
a relationship the player can confirm to `active`. That active row then feeds the
M16.2 Trust relationship input and the Passport representation headline. §7 is
explicit: "If a legacy route can still create authority outside P5.6B: that is a
defect." It cannot create *canonical* authority — the predicate blocks that — but
it creates **trust and projection authority**, which is authority.

**E-2 — an expired legacy row reads as current representation (Medium, inherited).**
`currentStatus` uses the stored `status`. A row with `status: 'active'` and
`endAt` in the past is shown on the club-facing Passport as the player's current
representation, naming the agency. The same row is correctly excluded from Trust.
Two readers of one store disagree about what "active" means.

**E-3 — the 2305 mirror is replay-reachable for post-migration legacy rows
(Low, latent).** The mirror is per-row idempotent via
`legacy.fromRepresentationId`, and a live database at 2307 never re-runs 2305. But
a snapshot restored at ≤2304 that also contains legacy rows created after the
original migration would mirror them into `representationAgreements` as `active`.
They would still carry `agentUserId: null` and still grant no private access, so
the blast radius is a summary row in the agency staff lane. Closing E-1 closes
this too.

## 4. Legacy row classification (§6)

Applied to the mirrored `representationAgreements` rows and to `db.representations`
itself. Nothing is activated because it looks activatable.

| Class | Meaning | Disposition |
| --- | --- | --- |
| **A — safely linkable historical record** | A confirmed, ended, non-disputed F10 row. | Mirror stays with `agentUserId: null`; visible as history and in the agency staff summary. Grants nothing. |
| **B — requires player reconfirmation** | A currently `active`, unexpired F10 row. | **Not** activated as canonical authority. The player must confirm a new P5.6B request from a named licensed agent. The legacy row remains readable history. |
| **C — disputed / expired / incomplete** | `disputed`, past `endAt`, or missing `confirmedAt`. | Mirrored with the corresponding terminal status. Never a Trust input, never a Passport headline. |
| **D — ambiguous** | Missing `agencyOrgId`, malformed dates, or a player who no longer exists. | Mirrored as `terminated_by_client`; excluded from every projection. Ambiguity fails closed. |
| **E — synthetic / demo** | Seeded or demo rows. | Stay in the demo lane only; never mirrored into a production-shaped authority. |
| **F — must remain legacy-only** | Anything with a `credential` note that was never document-reviewed. | Legacy-only. The M14 claim stays `pending`; it is never read as a licence. |

The governing rule for all six: **if authority cannot be proven, it is not
activated.** A legacy row names no licensed individual, so authority can never be
proven from one alone.

## 5. Writer disposition (§7)

There must not be two active authority writers. The plan:

1. `POST /org/representation/propose` becomes **read-only-lane closed**: it stops
   creating new rows and answers with a pointer to the canonical lane. Existing
   rows keep their player-side confirm / withdraw / dispute routes, because a
   player must always be able to end or dispute a record that already names them —
   removing those would trap them.
2. The club and grassroots "propose" control is replaced by an explanation of the
   canonical path; the list stays as history.
3. `m15` stops reading `db.representations` for the representation headline and
   reads the **canonical** lane, with the legacy lane contributing history only.
4. `m162/trust.mjs` keeps its state filter and gains a permanent regression.

## 6. What this audit gates

Nothing in P5.6E may read Lane B as authority. Every new integration seam —
Contact routing, Trial projection, opportunity share, transaction handoff, the
club Agent presence badge — resolves authority through the canonical predicate,
and the audit's classification is what the tests assert against.
