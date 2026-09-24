# M23 P6 — Existing Offer writer audit

Every occurrence of an offer or signing concept in the repository at
`8f062ac`, read before any P6 model was designed, and classified. The
question for each: can this code make `offer_made`, `offer_accepted`,
`offer_declined` or `signed` true, or create anything that looks like an
Offer? After P6 exactly one authority may: the canonical Offer service in
`scoutbox-server/m28/`.

## 1. Lifecycle states and their writers

| Site | What it is | Class | After P6 |
| --- | --- | --- | --- |
| `m17/shared.mjs:40–58` `ROOM_STATUSES` | the four offer states and `signed` exist in the status set since M23 P2 | lifecycle-only legacy vocabulary | unchanged; P6 adds no status |
| `m17/shared.mjs:197–241` `ROOM_TRANSITIONS` | `offer_consideration → offer_made → offer_accepted / offer_declined`, `offer_made → offer_consideration` (the club steps back), `offer_made → signed` (kept, evidence-gated) | lifecycle-only legacy | unchanged; P6 adds no edge |
| `m17/shared.mjs:265–282` `STATUS_EVIDENCE_REQUIRED` | `offer_made` needs `offer_sent`; `offer_accepted` needs `offer_accepted_by_recipient`; `offer_declined` needs `offer_declined_by_recipient`; `signed` needs `confirmed_join` | the precondition table, keyed by TARGET status so every path carries it | unchanged; P6 makes the three offer kinds answerable |
| `m23/lifecycle.mjs:142–146` `LIFECYCLE_ACTIONS` `sendOffer`, `recordOfferAccepted`, `recordOfferDeclined`, `confirmSignedOutcome` | the semantic actions, each mapping to one state, validated by the ONE validator with the evidence provider | **canonical future writer seam** — the route through which P6 moves the case | P6 calls `canTransitionRecruitmentCase` with these actions and writes through `ctx.applyLifecycleTransition`; nothing else |
| `m23/evidence.mjs:40–42, 169–170` | `offer_sent`, `offer_accepted_by_recipient`, `offer_declined_by_recipient` declared and answered `not_implemented` | **the seam P6 fills** | answered from `db.recruitmentOffers` through a pure predicate in `m28/offer.mjs`; still reads, never writes |
| `m23/index.mjs:75–159` `POST /org/rooms/:id/lifecycle` | a club user names an action; `sendOffer` from `offer_consideration` today answers 422 `LIFECYCLE_EVIDENCE_REQUIRED` (m23DecisionE2E J30) | lifecycle-only; **cannot** write an offer state without evidence | unchanged. Once an Offer is ISSUED the evidence exists, so the same action succeeds — through the same validator. A club user naming `recordOfferAccepted` still needs a recipient response to exist; naming it never creates one |
| `m17/rooms.mjs:660–745` `POST /org/rooms/:id/status` | the legacy client-supplied status string; gated since M23 §14 by `check.requiresEvidence` and fails closed with no provider | lifecycle-only legacy; **cannot** write an offer state without evidence | unchanged; regression G16 in `m23OfferE2E` proves `{status:'offer_made'}` with no Offer is 422 and `{status:'offer_accepted'}` with an unanswered Offer is 422 |
| `m17/rooms.mjs:756–790` `ctx.reopenRoom` | Second Look reopen; same gate | lifecycle-only | unchanged |
| `m17/rooms.mjs:807–830` `ctx.applyLifecycleTransition` | the single status writer (derives stage, bumps rev, appends history) | **canonical status writer** | P6 uses it; never assigns `room.status` |
| `m23/decisionRoutes.mjs` | ends at `offer_consideration`; "no offer row, draft, term or notification" | read-only with respect to offers | unchanged; a positive decision creates no Offer (regression G4) |
| `m12/scouting.mjs:520` `POST /org/cases/:id/stage` | refuses a Room outright (a stage cannot name the four offer statuses apart) | lifecycle-only legacy, already closed | unchanged |
| `m27/integration.mjs:408` handoff `eligibleCaseStatuses = ['offer_consideration']` | the transaction handoff is only invitable at offer consideration | read-only | unchanged |

## 2. Signing

| Site | What it is | Class | After P6 |
| --- | --- | --- | --- |
| `server.mjs:2462` `db.signings.push(signing)` | the ONE signing writer (issues a success-fee invoice, moves level, sets `under_contract`, adds to squad) | canonical signing writer, **not P6's** | untouched; P6 imports nothing from it and never calls it |
| `m23/evidence.mjs:83–93` `confirmed_join` | reads signings to satisfy `signed` | read-only | unchanged; an accepted Offer never satisfies `confirmed_join` (regression G33/G34) |
| `m26/transaction.mjs:21–25`, `m26/index.mjs:27–30` | the transaction is "NOT an Offer, NOT a Signing"; `db.signings` not imported | boundary statements | unchanged |
| `m18/nobodyMissed.mjs`, `m18/secondLook.mjs`, `m15/*`, `m13/*`, `m12/operations.mjs`, `m20/funnels.mjs` | read signings for history, funnels, follow-ups | read-only | unchanged |
| `storeContract.mjs:161` `signings` | "exactly one writer in the repository" | contract | still true after P6 |

## 3. Offer concepts already present

| Site | What it is | Class | After P6 |
| --- | --- | --- | --- |
| `storeContract.mjs:132` `recruitmentOffers: { guarantee: 'optional' }` | the store name reserved since P2; "the journey reports offer.available=false" | **canonical future store** | becomes `{ guarantee: 'migration', owner: 'm28' }`; created by `m270_001_recruitment_offers` |
| `m23/journey.mjs:16, 47, 260–263, 277, 320` | the journey projects `offer: { available, records:[{id,type,status}] }` and derives `offerAwaitingResponse` from `status === 'sent'` | read-only, migration compatibility | the projection reads the canonical rows; `offerAwaitingResponse` is derived from an ISSUED, unexpired current revision |
| `m23/lifecycle.mjs:188–192` `derivedConditions.offerAwaitingResponse` | derived condition | read-only | unchanged (input now real) |
| `m23/index.mjs:199–205` `migrateM23` | "db.recruitmentOffers still arrives with the phase that actually writes offers" | comment | that phase is P6 |
| `m26/transaction.mjs:436–458` `offerReadiness(tx)` | the ONE seam a future Offer needs: `canStartOfferWorkflow` + blockers, "no offer exists, no offer can be created here" | **read-only readiness seam** | P6 re-evaluates it at ISSUE when an Offer references a transaction; it never creates a transaction and a transaction never creates an Offer |
| `m26/transaction.mjs` `terms: { versions: [] }` on a transaction | P5.6A DR-38's reserved `transactionTerms` shape (club-to-club) | unrelated to the Player Offer | not used by P6: the engaging club's Offer to the player is a different object from club-to-club transaction terms (§8) |
| `m17/shared.mjs:459` decision recommendation `'offer'`; `m23/decision.mjs:52` `progress → recommendation 'offer'` | the club's internal recommendation word | decision vocabulary, read-only | unchanged; "offer" here means "we intend to consider an offer" |
| `m20/timeSeries.mjs:207`, `m20/funnels.mjs:34–50, 244` | analytics treat `offer_made` / `offer_accepted` as rungs, `offer_declined` as non-progress | read-only analytics over history entries | unchanged; P6 writes the same `room_status_changed` entries |
| `m17/rooms.mjs:447, 509` `view === 'offers'` list filter; `DECISION_OUTSTANDING` reason | read-only projections | unchanged |
| client apps: `roomsApi.ts` `'offer'` recommendation, `dc.*` copy "not an offer" | vocabulary/copy | unchanged |
| `M23_P5_*`, `M23_P56*` documents | frozen statements that P6 owns Offer | docs | this milestone |

## 4. Unrelated text

`domain.mjs:286` and `trialRoutes.mjs:312–313` "Offer at most N slots" (the verb), `m21/index.mjs` "offer a structured field", `m22/policy.mjs` "capabilities this engine can offer", `m25/conflict.mjs` "legal-advice offer" (the FA particulars clause). None is an Offer object.

## 5. Verdict

- **Unsafe direct writers requiring retirement: none.** Every path to an
  offer state already runs through `STATUS_EVIDENCE_REQUIRED` and fails
  closed. P6 does not retire a writer; it supplies the evidence and becomes
  the only thing that can.
- **Duplicate Offer authority after P6: none.** The canonical Offer service
  is the only code that creates or mutates a `recruitmentOffers` row; the
  evidence provider reads those rows; the lifecycle validator asks the
  provider; the single status writer writes.
- **Signing writer: unchanged, un-imported, un-called.**
