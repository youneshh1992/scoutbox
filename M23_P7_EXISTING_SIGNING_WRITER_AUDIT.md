# M23 P7 — Existing signing writer audit

Every occurrence of a signing, `signed`, `under_contract`, contract-date,
invoice, level or e-signature concept in the repository at `1217e5b`, read
before any P7 model was designed, and classified. The question for each:
can this code create a completed signing, make `signed` true, or set a
Player's contract status? After P7 exactly one authority may: the
canonical signing completion in `scoutbox-server/m29/`.

Classes: **canonical future writer** · **legacy writer to retire/route** ·
read-only · analytics · compatibility · **unsafe direct writer** ·
unrelated text/test/docs.

## 1. `db.signings` — the completed-signing record

| Site | What it is | Class | After P7 |
| --- | --- | --- | --- |
| `server.mjs:188` `db.signings ??= []` | store init (also `m182/migrations.mjs:141`, `m20/index.mjs:50`) | compatibility | unchanged; `storeContract.mjs:166` keeps the store `migration`-guaranteed, owner core, "exactly one writer" |
| `server.mjs:2436–2497` `POST /org/players/:id/signing` | **the only writer today**: any club user of a visible, unblocked player records a signing with no evidence, no Offer and no case; the same handler issues the success-fee invoice, moves the player's level, pushes the timeline, adds the grassroots squad row, sets `contractStatus: 'under_contract'` and `availability: 'not_seeking'`, notifies, broadcasts | **legacy direct writer — routed, not deleted** | the side effects move into ONE function, `recordCompletedSigning` in m29, which the canonical completion calls; the legacy route calls the same function with `method: 'LEGACY_RECORDED'` and is refused (`409 SIGNING_CANONICAL_REQUIRED`) whenever a canonical Offer between that club and player was accepted or a signing package exists — a recruitment that went through P6 cannot be short-circuited. Clients that never used P6 (the club and grassroots "Record signing" buttons, apiE2E, m12E2E, m15E2E) keep working. Retirement of the route itself is flagged for P7.1 |
| `server.mjs:2499` `GET /org/signings` | the club's list | read-only | unchanged |
| `server.mjs:2749–2760` pathway record | reads `ts`, `orgId`, `playerId` | analytics | unchanged; the canonical row keeps those fields |
| `server.mjs:2865, 2963–2967, 3976` counts / live scout tallies / capability counts | counts | analytics | unchanged |
| `adapters.mjs:162` `billing.invoiceForSigning(signing, org)` | pushes `db.invoices` when inside the attribution window | side effect of the writer | called from `recordCompletedSigning` only |
| `m12/operations.mjs:29, 125–136, 292–294` follow-ups and outcome tables | schedules 3/6/12-month follow-ups from `signedAt ?? ts`; suppression | read-only / analytics | unchanged; the canonical row carries `signedAt` too |
| `m12/scouting.mjs:606`, `m17/rooms.mjs:1295` case/room `links.signingId` | link an existing signing row (same org + player) to a case | read-only | unchanged; the canonical completion also sets `room.links.signingId` |
| `m13/insight.mjs:68, 326`, `m13/groups.mjs:230` | later-signing lookups, org counts | analytics | unchanged |
| `m15/passport.mjs:93–100`, `m15/shared.mjs:315` | Passport club history: `id, orgId, orgName, ts`; timeline `signed` entries | read-only projection | unchanged; no term or fee is read |
| `m18/nobodyMissed.mjs:84, 128`, `m18/secondLook.mjs:157` | "club confirmed" facts | read-only | unchanged |
| `m23/evidence.mjs:60–66, 91–100` `signingSupports` / `confirmed_join` | the ONLY evidence that lets a case reach `signed`: a row for this org + player without `cancelledAt/revokedAt/voidedAt` | read-only (the gate) | unchanged; the canonical completion writes the row FIRST and then asks the lifecycle, so the gate is satisfied by real evidence |
| `m23/journey.mjs:274, outcome.signing` | "a separate, confirmed fact, never inferred from `offer_accepted`" | read-only | extended with the package state (ids and status only) |
| `m26/index.mjs:30`, `m28/index.mjs:25`, `m28/offer.mjs:17` | comments asserting "no `db.signings` read or write" | unrelated text | true before and after P7 |
| `seed.mjs` `sign-legacy-1` (via m23P4AClosureE2E L7d), demo `db.signings` rows | seeded legacy rows | compatibility | never reinterpreted as packages (§6) |

## 2. `signed` — the lifecycle state

| Site | What it is | Class | After P7 |
| --- | --- | --- | --- |
| `m17/shared.mjs:53, 77, 88, 125, 148` | vocabulary, label, terminal set, reopen map | lifecycle-only | unchanged |
| `m17/shared.mjs:224, 227` `ROOM_TRANSITIONS` `offer_made → signed`, `offer_accepted → signed` | the edges | lifecycle-only | unchanged; P7 drives `offer_accepted → signed` only |
| `m17/shared.mjs:281` `STATUS_EVIDENCE_REQUIRED.signed = confirmed_join` | the precondition | the gate | unchanged |
| `m23/lifecycle.mjs:146` `confirmSignedOutcome` (`roles: ['recruitment_admin']`) | the semantic action | lifecycle-only | P7's completion calls it through `applyLifecycleTransition` after the row exists; the completing user must be a recruitment lead |
| `m17/rooms.mjs:660–745` `POST /org/rooms/:id/status` (legacy status string) and `m23/index.mjs` `POST /org/rooms/:id/lifecycle` | evidence-gated since M23 §14 | lifecycle-only legacy | unchanged; still cannot reach `signed` without a signing row (regression kept: Q2/Q3 in P6.1, X in P7) |
| `m17/rooms.mjs:807–830` `applyLifecycleTransition` | the single status writer | canonical status writer | used; never bypassed |

## 3. `under_contract`, contract dates, level, invoice

| Site | What it is | Class | After P7 |
| --- | --- | --- | --- |
| `server.mjs:2490` `p.contractStatus = 'under_contract'` | written by the legacy signing route at recording time — its existing meaning is "a real contract was executed", regardless of the start date | legacy writer | written only inside `recordCompletedSigning` (M23_P7_CONTRACT_STATUS_SEMANTICS.md) |
| `server.mjs:3286` contract-status vocabulary (`under_contract, expiring_summer, scholarship_ending, release_approaching, free_agent, unknown`) | player-facing search vocabulary | read-only | unchanged |
| `seed.mjs:176, 247, 268` | seeded players already `under_contract` with no signing row | compatibility | never reinterpreted |
| `contractUntil` / `contractStartDate` | **absent from the server** (only agency affiliation dates exist in m24) | — | P7 records `contract: { startDate, endDate }` (DATE_ONLY, from the accepted Offer's terms, validated) on the signing package and the completed row; the Player model is not widened (§27 limitation documented) |
| `domain.mjs:100` `playerLevelAfterSigning` + `server.mjs:2469–2481` | level move on signing | side effect | inside `recordCompletedSigning` only |
| `m13/transitions.mjs:194` admin level review | "the ONLY path that changes level outside signings" | unrelated (audited admin) | unchanged |
| `adapters.mjs:157–187` success-fee invoice | side effect | inside `recordCompletedSigning` only; never twice for one signing (idempotent by `signingId`) |

## 4. e-signature / provider concepts

None exist: no DocuSign/Adobe adapter, no cryptographic signature engine,
no `esign` code. P7 adds none and claims none (§19, §57, §103). The
methods P7 implements are `PLATFORM_ACKNOWLEDGMENT` (an authenticated
actor completes their party against an exact document digest, recorded
with server time) and `UPLOAD_EXECUTED_DOCUMENT` (a club uploads the
executed document as evidence). Any other `method` fails closed.

## 5. Offer acceptance and its neighbours

| Site | Class | After P7 |
| --- | --- | --- |
| `m28/index.mjs` accept route | writes the response and moves the case to `offer_accepted`; **no signing** (P6 A23, P6.1 truth block) | unchanged; P7 adds a read-only `signing` summary to the club/recipient/agent views |
| `m28` recipient views, notifications ("accepting is not a signing") | text | unchanged |
| `m26` transactions (`transaction ≠ signing`) | read-only seam `offerReadinessFor` | unchanged; a package carries `transactionId` by reference only |
| `m24`/`m27` agent basis, scope, licence | read seams | reused: an agent's signing view requires basis + scope + licence at read, exactly as the Offer projection |

## 6. Uploads / evidence / documents

| Site | Class | After P7 |
| --- | --- | --- |
| `m14/index.mjs:99–130` `addEvidence`, `storeEvidenceFile` (sha256, mime/signature sniffing, size limit, no scanner pretended) | the ONE upload path | reused through the m14 seam for the signing document and the executed document; `verEvidence` gets rows with `orgId`, `visibility: 'organisation_internal'`, `meta.signingPackageId` |
| `m28` `resolveDocuments` / `documentHandler` | Offer document references into the vault | pattern reused; a signing document is a reference plus the digest of the exact bytes |
| `adapters.mjs` `createStorage` | local disk / S3 | unchanged |

## 7. Guardians, minors, agents

| Site | Class | After P7 |
| --- | --- | --- |
| `m28/offer.mjs:116` `MINOR_OFFER_PATHWAY_ENABLED` all false | fail-closed | mirrored by `MINOR_SIGNING_PATHWAY_ENABLED` all false: a package for a guardian-addressed Offer cannot be started (§14); guardian routes are dormant |
| `server.mjs:1226` guardian auth, `req.guardian.childIds` | auth | reused for the dormant routes |
| agent tiers `m24/shared.mjs`, `findOwnAgreement` | read seams | reused; no agent signing route exists |

## 8. Audit, events, notifications, rate limits

| Site | Class | After P7 |
| --- | --- | --- |
| `m182/eventRegistry.mjs` Offer entries, `server.mjs:4589` `EMITTED_EVENTS` | registry | seven `signing_*` org-private events added (ids + status word) |
| `m182/notificationPrefs.mjs:74, 129, 165` (`offer_updates`, legacy `signing → activity`) | categories | new type `recruitment_signing` → new category `signing_updates` (default on, not mandatory); the legacy `signing` type stays mapped as it is |
| `m181/rateLimit.mjs:115–118` Offer policies | limiter | five `signing_*` policies added |
| `m12/shared.mjs` `audit(...)`, `m28` `hist(...)` | audit | the package keeps an append-only history; the case gets audit rows |

## 9. Client code

| Site | Class | After P7 |
| --- | --- | --- |
| `scoutbox-club/src/screens.tsx:1296–1304`, `scoutbox-grassroots/src/screens.tsx:1694–1702` "Record signing" → `api.recordSigning` | legacy client of the legacy route | unchanged in P7; it inherits the server's `SIGNING_CANONICAL_REQUIRED` refusal for P6-driven recruitments (rendered through the existing error path) |
| `scoutbox-club/src/offerPanel.tsx` "signing pending" | text | a Signing tab is added beside it |
| `scoutbox-player/src/components/M23Offer.tsx` "Accepted — signing pending" | text | a Signing section is added under Offers |
| `scoutbox-agent/src/screens.tsx` Offers tab "signing pending" | text | a read-only signing line per shared Offer |

## 10. Conclusion

Before P7 there is exactly one writer of `db.signings`
(`POST /org/players/:id/signing`), unsafe in the sense of §3 D: it records
a signing on a club user's word alone. After P7 exactly one function
writes `db.signings`, the lifecycle `signed` move and the player's
`contractStatus`: `recordCompletedSigning` in `m29/index.mjs`, reached by
the canonical completion (with a package, parties and evidence) and, for
legacy non-Offer recruitments only, by the legacy route. A drift
regression (`m23SigningE2E` group Z) asserts the writer count.
