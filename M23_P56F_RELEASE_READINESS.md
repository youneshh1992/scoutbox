# M23 P5.6F — release readiness (reconstructed)

> **P5.6F was reconstructed from the frozen `b8556c1` base after an ephemeral
> container loss. The reconstructed implementation is evidenced independently;
> original lost P5.6F hashes are historical references only.**

Thirty-one areas: PASS, FAIL, or DEFERRED WITH REASON. The evidence column names
what was run, so a reader can re-run it rather than trust the verdict.

---

| # | Area | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | **AUTH** | **PASS** | Player token, club token and the shared admin key all refused on the lanes that are not theirs. An affiliation ended mid-session is refused on the next request across five agent routes with no re-login. `login_failure` measured on seven properties (F-5), and — after the review pass — a guardian named by id or by email shares **one** budget (F-11, AA6–AA8b). |
| 2 | **REPRESENTATION** | **PASS** | One predicate. 22 temporal cases: future start, +1ms start, `NaN`, ISO string, `Infinity`, end exactly now, past end, unreadable end — all refused; open-ended and in-term still granted. Six non-active states, unconfirmed, foreign agent, legacy mirror: none grants. |
| 3 | **COMPLIANCE** | **PASS** | `m23AgentComplianceE2E` 346/194 green; context create/parties/representations under key + rev; close is one-shot and refused by state on a second call. |
| 4 | **CONFLICT** | **PASS** | 25 outcome pairs against the implemented order; five forbidden downgrades asserted individually; the input fingerprint is key-order independent. Divergence from the frozen prose recorded as F-4, code unchanged. |
| 5 | **CONSENT** | **PASS** | Request under key, answer under key + rev. Revoked, wrong-party and unknown-id all refused; an unknown consent id is the same 404 whoever asks. |
| 6 | **MINORS** | **PASS** | A minor is **byte-identical** to a player who does not exist, and a forged `dob`/`isAdult`/`guardianConsent`/`minorPathway` body is refused identically to the ghost. Pathway disabled in every jurisdiction (every value checked). **And F-8 fixed: unknown age is no longer read as adult.** |
| 7 | **TRANSACTION** | **PASS** | Ten states; `m23AgentTransactionE2E` 404/215 green; nine document visibility classes; no state names an offer, a signing, a commission or a fee. |
| 8 | **CONTACT** | **PASS** | Canonical M23 P3 reused. `m23ContactE2E` 428/246 and `m23ContactLive` 82 green. |
| 9 | **INBOX** | **PASS** | Canonical Inbox reused; agent participation through the P5.6E seam. `m23AgentIntegrationE2E` 535/281 green. |
| 10 | **TRIAL** | **PASS** | Canonical M23 P4B reused. `m23TrialE2E` 535/331 and `m23TrialLive` 122 green; the agent cannot accept for the player or read a private assessment. |
| 11 | **PASSPORT** | **PASS** | Player-owned. Five candidate agent writer routes probed; none exists or is permitted. |
| 12 | **TRUST** | **PASS** | Two candidate writer routes absent; an invalid relationship is not active Trust evidence. |
| 13 | **CLUB PRIVACY** | **PASS** | Twelve `/org` surfaces probed with an agency token: **zero** foreign-org references. A **real** club case id is concealed byte-identically to an invented one across four routes. |
| 14 | **SAME-AGENCY PRIVACY** | **PASS** | Four colleague tiers and the agency administrator all refused the client record and find no mandate in their own list; the representing agent reads it 200. The wall is between people. |
| 15 | **GRASSROOTS** | **PASS** | A3 closed by observation: 48 checks / 27 negative in Chromium. Seven agency terms absent from the nav, five agent routes 403, no agent field, no DOB, radius withholding 12 of 14 with each withheld id answering 403 identically. |
| 16 | **T&S** | **PASS** | The shared admin key is not a reviewer (401); an agent session likewise; no secret hash in a projection; a wrong secret and an unknown reviewer share one refusal; `attribution: authenticated_reviewer`. |
| 17 | **NOTIFICATIONS** | **PASS** | A named non-client gets one factual notice and nothing more; a deep link does not bypass current authorization. |
| 18 | **EVENTS** | **PASS** | No offer, signing or commission event in `EVENT_REGISTRY`. |
| 19 | **AUDIT** | **PASS** | Compliance decisions attributed to a named reviewer; policy publication dual-control; the migration's seeded policies carry a system provenance. |
| 20 | **TOMBSTONES** | **PASS** | A deleted player is no longer named in the agency's client list; no resurrected PII. |
| 21 | **PERSISTENCE** | **PASS** | Seven persistence suites, 426 checks, green. A write survives a real restart (measured end to end). |
| 22 | **MIGRATION** | **PASS** | 2307, unchanged — no migration added. Replay structurally deterministic (33/33 differing leaves are clocks), idempotent on a second and third pass, ledger does not grow. Cold clone reaches 2307 via the response header. |
| 23 | **RATE LIMITS** | **PASS** | 51 policies. P5.6E's two survive and are re-proved (`opportunity_share` 60/h actor, `transaction_handoff` 30/h org); `login_failure` added and measured. One-shot state changes deliberately unquota'd, with the reason recorded. |
| 24 | **IDEMPOTENCY** | **PASS** | Every mutation classified; nothing left "neither justified". Same `clientKey` + same payload replays with `idempotent: true`; different payload → 409; a non-string key → 400. |
| 25 | **CONCURRENCY** | **PASS** | Two disclosure writes on one rev → 409. The two state-changed-but-session-live cases both refused on the next request. |
| 26 | **EN/FR** | **PASS** | French asserted on the agent, compliance and transaction surfaces with no English fallback leaking, and the French screen withholds exactly what the English one withholds (integration suite N6c). |
| 27 | **ACCESSIBILITY** | **PASS** | Controls labelled; the six transaction tabs a labelled tablist with exactly one selected; keyboard reachable; `alert`/`status` roles on refusals — all in the live suites, green. |
| 28 | **RESPONSIVE** | **PASS** | All six widths on the Agent portal. **1024 and 768 added this milestone (F-6)** after the audit found neither had ever been rendered on it; each new check asserts content as well as fit. |
| 29 | **PERFORMANCE** | **PASS** | 16 perf/load suites green. |
| 30 | **FRESH CLONE** | **PASS** | §26 executed from the reconstructed tip with nothing reused (0 node_modules, 0 dist, 0 db carried, counted): install, cold bootstrap to 2307, port release, 5/5 typechecks, 5/5 builds, 247-check suite, 48-check live journey. |
| 31 | **RECOVERY BUNDLE** | **PASS** | Bundles at R1/R2/R3 with recorded SHA256s. Restore **executed**: verify clean, target reset to the origin state fetched the branch out of the bundle, and every tracked file compared byte-identical. No secrets: five blank `.env.example` templates. |

---

## The two things that are not a PASS, and are not hidden

**A2 — a transaction DRAFT may name an adult non-client: ACCEPTED.** A property
of P5.6D's frozen party model, which separates naming a party from representing
one. Twelve authorities re-proved as not granted by naming. Narrowing it means
changing a frozen contract and breaking its own AD5 assertion, which §29 forbids.

**A1 — an agency org reaches generic `/org` list infrastructure: a product-shape
question.** The blanket gate was built in P5.6E and broke six frozen suites,
decisively `m23TrialE2E` W3. Classified A/B/C/D instead, with the isolation
measured: twelve surfaces, zero foreign references, and category B refused by
concealment against a real case id.

## What this reconstruction found that the original did not

**F-8**, a MEDIUM safeguarding fail-open in the platform's age choke point: a
record with `dob: null` computed as a 56-year-old and read as an **adult** on both
age paths, because `new Date(null)` is the epoch rather than an invalid date. The
import path stores exactly that shape. Repaired at the root; 65 call sites; twelve
frozen suites re-run green.

It is worth being plain about what that means for the original P5.6F's own claim
of release readiness: it declared zero open Medium defects while this one was
present and undetected. The reconstruction is not merely a re-creation.

## The review pass

A second reviewer went over the closed milestone with the same brief it had
applied to P5.6A–E. It changed nothing above from PASS to anything else, and it
changed three things that matter to whether the PASSes are believable:

- **Two product findings** (F-11 guardian alias budgets, F-12 unreadable dob at
  sign-up) and **one user-found defect** (F-10 the demo's dead-end login), all
  fixed with regressions that can fail.
- **Six weak assertions in this milestone's own suites** — the shape it had
  filed as F-9 against P5.6E — pinned to exact statuses and single branches.
- **The contention tooling committed** (`e2e/tools/`), so PASS on row 29 and
  row 31 is reproducible from a fresh clone rather than from a scratchpad that
  a container rebuild erases — the failure mode this whole milestone is about.

## Verdict

**31 PASS, 0 FAIL, 0 DEFERRED.** Zero open Critical, High or reasonably-fixable
Medium; zero security / privacy / authorization / data-integrity Low that should
be repaired before release. Two Low remain by decision (F-4, a stale order in a
frozen document; F-9, an unconditional pass in a frozen suite) — both
documentation/test-integrity, neither a product risk.

**ScoutBox Agent is release-ready as a product domain.**
