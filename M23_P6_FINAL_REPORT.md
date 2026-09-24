# M23 P6 — Canonical Offer Workflow: final report

Branch `claude/desktop-project-migration-wyk3ec`, from the frozen tip
`8f062ac` (P5.7 R4). Local commits only — **no push, no PR, no deploy, no
migration, no signing** — as the mandate requires (§83, §90, §91, §92).

The principle this milestone builds and proves:

    Recruitment Decision ≠ Offer ≠ Offer Acceptance ≠ Signing

A positive P5 decision opens the door to considering an Offer and creates
none. An explicit club act drafts one. Issuing freezes an exact, immutable
revision and moves the case to Offer made through the ONE validator and
the ONE writer. The recipient's own acceptance or decline — nobody else's —
moves it to Offer accepted / Offer declined. An accepted Offer is NOT
signed: no `db.signings` row, no `signed`, no `under_contract`. "Offer
accepted — signing pending" is the wording everywhere it matters.

## The mandate, item by item (§87)

| # | Item | Answer |
| --- | --- | --- |
| 1 | starting tip | `8f062ac` (local = remote at Stage 0; ahead/behind 0/0; clean) |
| 2 | final local tip | ⟨FINAL_TIP⟩ |
| 3 | starting schema | 2307, 17 migrations |
| 4 | final schema | 2307, 17 migrations |
| 5 | migration name | none — `recruitmentOffers` is module-guaranteed by m28 (decision: M23_P6_OFFER_MODEL.md §2) |
| 6 | Offer store / model | `db.recruitmentOffers`; one row per Offer with embedded, append-only revisions, responses, receipts, agent share, keys, history (M23_P6_OFFER_MODEL.md) |
| 7 | revision model | monotonic `revisionNumber`, ≤20; DRAFT editable, ISSUED immutable; current (club working) vs live (latest issued) revisions; supersede on issue; an answer discards an unissued draft (M23_P6_OFFER_TERMS_VERSIONING.md) |
| 8 | statuses | DRAFT, ISSUED, ACCEPTED, DECLINED, WITHDRAWN, EXPIRED, SUPERSEDED — terminal at revision level, no SIGNED |
| 9 | lifecycle writer | `ctx.applyLifecycleTransition` only, after `canTransitionRecruitmentCase` with the real evidence provider; m28 never assigns a status (E2E A24) |
| 10 | P5 integration | create gate requires a finalized progress decision (`decision_progress` evidence); `decisionId` referenced, rationale never travels; no auto-Offer |
| 11 | transaction integration | `offerReadinessFor` seam on m26 (engaging entity, linked case), re-evaluated at issue, codes only; a transaction never creates an Offer |
| 12 | Agent integration | own agreement + `client_private` decision + employment/transfer scope + the client's per-Offer share; read-only; no accept route; same-agency 404 |
| 13 | guardian / minor | recipient rule re-derived at issue and answer; pathway table CLOSED in every jurisdiction → issue to a minor refused 422; guardian routes dormant, fail-closed (M23_P6_MINOR_GUARDIAN_MODEL.md) |
| 14 | Club role model | `offer_view` 0, `offer_draft` 2, `offer_issue` 2 on `roomCan`; re-derived per request |
| 15 | Player authority | the addressed adult only, exact revision, own act; two explicit steps in the app |
| 16 | draft privacy | a DRAFT is absent (not redacted) from every recipient and agent payload; a draft withdrawn before issue never appears |
| 17 | issued privacy | recipient: issued revisions, message, documents by Offer id, expiry; agent: terms and state; never the note, decision, transaction, readiness or vault id (M23_P6_OFFER_PRIVACY_MATRIX.md) |
| 18 | terms model | `{ offerType, role, squad, startDate, endDate, conditions }`; DATE_ONLY days; no compensation field |
| 19 | expiry | instant with explicit offset/Z or ms via P5.7 `parseInstant`; ≥1 h ≤180 d at issue; lazy, fails closed |
| 20 | temporal helpers | `parseInstant`, `parseStrictDateOnly`, `isExpiredAt`, `readInstant`, `isAbsent`, `DAY_MS` from `temporal.mjs`; no `new Date(string)` in m28 |
| 21 | withdrawal | DRAFT or unanswered ISSUED; an issued withdrawal steps the case back to `offer_consideration` via `considerOffer` (an existing edge); reason club-private; recipient told |
| 22 | supersession | issuing revision N+1 marks N SUPERSEDED; N stays readable; N not answerable |
| 23 | accept | `POST /player|guardian/offers/:id/accept {revisionId, clientKey}` → ACCEPTED, `recordOfferAccepted` with the recipient as actor → `offer_accepted`; response carries `signing:{created:false}` |
| 24 | decline | idem with optional reason → DECLINED → `offer_declined`; the club reads the reason |
| 25 | concurrency | ONE Offer rev; `expectedRev` required integer on every club mutation; optional on answers; share/receipt do not bump it |
| 26 | idempotency | `clientKey` per act, lists on the record, fingerprinted create; replay after restart |
| 27 | rate limiting | `offer_draft_write` 120/h org, `offer_issue` 30/h org, `offer_withdraw` 30/h org, `offer_response` 30/h per person; replay before the limiter |
| 28 | events | `offer_draft_created`, `offer_draft_updated`, `offer_issued`, `offer_superseded`, `offer_withdrawn`, `offer_responded` — org_private, ids (+ status word) |
| 29 | notifications | type `recruitment_offer`, category `offer_updates` (on, not mandatory); factual lines; recipient, club, shared agent |
| 30 | Inbox | no second inbox: the canonical notifications list carries the Offer id as `refId` |
| 31 | deep links | re-authorised on open: another player 404, a lapsed agent 403/404 |
| 32 | documents | `db.verEvidence` references owned by the club; recipient fetch by Offer id on issued revisions; bytes from the storage adapter |
| 33 | same-agency privacy | 404 REPRESENTATION_NOT_FOUND; nothing says an Offer exists |
| 34 | block behaviour | no draft/issue/revise while blocked; accept refused (403), decline allowed, withdraw allowed |
| 35 | legacy lifecycle compatibility | no new state, no new edge; `STATUS_EVIDENCE_REQUIRED` unchanged; legacy routes still fail closed |
| 36 | signing boundary | absolute: no signing read/write, no `signed`, no `under_contract`; P7 owns signing |
| 37 | P5 rationale leak test | E2E U1–U3, #36; live B2c, E4, N10 — none |
| 38 | transaction-private-data leak test | E2E T (#37) with a transaction note sentinel — none |
| 39 | m23OfferE2E | 447 checks, 284 negative — green |
| 40 | m23OfferPersistence | 59 checks — green |
| 41 | m23OfferLive | 98 checks, 30 negative, 0 page errors — green |
| 42 | temporal suite | 493 / 335 — green |
| 43 | full server battery | 40 suites + apiE2E: 41/41 green (38 existing + 2 new + apiE2E) |
| 44 | apiE2E | 130/130 |
| 45 | browser / live | 15 suites green (14 existing + m23OfferLive 98), 0 page errors, ports released |
| 46 | typechecks | 5/5 |
| 47 | builds | 5/5 |
| 48 | EN/FR | club 2312/2312, grassroots 2190/2190; player/agent typed; no server English in any screen |
| 49 | accessibility | live N15 + the two-step player answer; no colour-only state |
| 50 | perf / load | m23OfferPerf + six suites green; no N+1; no index needed |
| 51 | clean boot | 2307; 0 migrations on re-boot; persisted; ports released |
| 52 | migration replay | n/a (none added); pre-P6 snapshot boots empty (P §1) |
| 53 | fresh clone | from fbd1292, nothing reused: install, 2307, cold boot, 5/5, 5/5, m23OfferE2E/Persistence, temporal, transaction, decision suites, live Offer journey 98 — all green |
| 54 | recovery bundles | R1 `a47c086`, R2 `a47b7d0`, ⟨BUNDLES⟩ — SHA256 in the delivery messages; none pushed |
| 55 | Critical found/fixed | 0/0 |
| 56 | High found/fixed | 3/3 (D-P6-1 evidence clock; D-P6-2 withdrawn-draft integrity 500; D-P6-3 withdrawn draft listable) |
| 57 | Medium found/fixed | 6/6 (D-P6-4 live-vs-current gate; D-P6-5 overwritten keys; D-P6-6 split rev contract; D-P6-7 receipt from list; D-P6-8 agent hash regex; D-P6-14 server English in FR screens) |
| 58 | Low found/fixed | 5/5 (D-P6-9 registry scanner; D-P6-10 superseded frozen assertions; D-P6-11 missing i18n key; D-P6-12/13 test-side) |
| 59 | remaining Low | 0 |
| 60 | open Critical | 0 |
| 61 | open High | 0 |
| 62 | open Medium | 0 |
| 63 | open relevant Low | 0 |
| 64 | known flakes | 0 |
| 65 | tree state | clean at every commit; `m22/perf.json` untouched; demo bundles (gitignored) rebuilt and fresh |
| 66 | ahead/behind | 5 ahead of `origin/claude/desktop-project-migration-wyk3ec` (8f062ac), 0 behind |
| 67 | pushed? | NO |
| 68 | PR? | NO |
| 69 | deployed? | NO |
| 70 | ready for P6.1? | YES — the Offer domain is canonical, tested and documented; P6.1 (whatever it names: jurisdictional minor policy, transfer/loan Offers, or P7 signing) starts from the R5 tip |

## What was deliberately not done

- No migration (schema stays 2307); the store is module-guaranteed.
- No Offer to a minor (pathway closed); no minor Agent representation.
- No transfer/loan Offer type; no club-to-club terms.
- No signing, countersignature, e-signature or `under_contract` change.
- No AI counter-offer, ranking, nudge, or auto-acceptance.
- No admin Offer surface; no global Offers destination in any navigation.
- No change to Trust, Passport, Second Look, Nobody Missed, analytics
  definitions, `m22/perf.json`.

## §88 Truth block

```
Starting tip: 8f062ac
Remote starting tip: 8f062ac

P6 Canonical Offer Workflow complete: YES

Canonical Offer store: YES
Canonical revision model: YES
Draft terms mutable only before issue: YES
Issued revision immutable: YES
Superseded revision cannot be accepted: YES
Withdrawn revision cannot be accepted: YES
Expired revision cannot be accepted: YES

Positive P5 decision automatically creates Offer: NO
Canonical Offer issue required for offer_made: YES
Canonical accept required for offer_accepted: YES
Canonical decline required for offer_declined: YES

Draft visible to Player: NO
Draft visible to Agent: NO
P5 private rationale visible in Offer: NO
Transaction private notes visible in Offer: NO
Private assessment/Box Cam observations visible in Offer: NO

Same-agency membership alone grants Offer access: NO
Agency admin automatically sees client Offer: NO
Agent can impersonate Player acceptance: NO

General Agency minor discovery enabled: NO
Minor Agent representation pathway newly activated: NO
Guardian control preserved: YES
Shared age gate uses P5.7 canonical temporal logic: YES

Offer expiry uses canonical temporal helpers: YES
Impossible expiry timestamps accepted: NO
Client clock authoritative: NO

Accept vs decline race has one winner: YES
Accept vs withdraw race has one winner: YES
Duplicate issue idempotent: YES
Stale rev rejected: YES

Offer acceptance creates db.signings: NO
Offer acceptance sets signed lifecycle: NO
Offer acceptance marks Player under_contract: NO
Signing workflow implemented: NO

m23OfferE2E passed: YES
m23OfferPersistence passed: YES
m23OfferLive passed: YES
Temporal integrity suite passed: YES
Full server battery passed: YES
apiE2E passed: YES
Relevant browser suites passed: YES
Five-app typecheck passed: YES
Five-app build/export passed: YES
EN/FR parity passed: YES
Accessibility verified: YES
Clean boot passed: YES
Migration replay passed: YES (n/a — none added; pre-P6 snapshot boots clean)
Fresh clone passed: YES

Open Critical: 0
Open High: 0
Open Medium: 0
Open relevant Low: 0
Known flakes: 0

Local tip: ⟨FINAL_TIP⟩
Remote tip: 8f062ac (unchanged)
Pushed: NO
PR: NO
Deployed: NO
```

## §89 Success lines

- A Recruitment Decision authorises considering an Offer and creates none; one explicit club act does.
- An issued revision is exact and immutable; a change is a new revision; the old one is history the recipient can still read.
- Only the addressed recipient's own act moves a case to accepted or declined — through the ONE validator and the ONE writer.
- An accepted Offer is not signed: no signing row, no signed state, no contract; "Offer accepted — signing pending".
- Drafts, notes, rationales and transaction notes never leave the club; a colleague, an administrator, another player and an invented id all read the same 404.
- Nothing was migrated; nothing was pushed; nothing named signing exists.

**STOP** (§92): P6.1 and P7 are not begun.
