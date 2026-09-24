# M23 P6.1 — Offer hardening defect register

Every defect found during the hardening and adversarial closure of the
canonical Offer, in product code or in a suite's assumption. Severity
follows the P6 scale. Legacy impact says whether any pre-P6.1 data or
behaviour was affected. No defect required a migration; none touched
signing, negotiation or a minor pathway.

| ID | Severity | Component | Reproduction | Actual | Expected | Impact | Root cause | Fix | Regression | Status | Release-blocking? | Legacy impact |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D-P61-1 | High | m28/offer.mjs `payloadFingerprint` | create an Offer with key K and terms A; retry K with terms B | 200 `idempotent: true` — the Offer with terms A was replayed, B silently lost | 409 `OFFER_IDEMPOTENCY_CONFLICT` | a retry that changed a term (a corrected start day, a different role) was answered as if it had succeeded | `JSON.stringify(parts, Object.keys(parts).sort())` — a replacer array filters every nesting level, so `terms` serialised as `{}` | deep canonical serialisation (every level key-sorted) | hardening G11; P6 #47 still green | fixed | yes | a key written before the fix stores the old (shallow) fingerprint, so an identical retry of it after the fix answers 409 `OFFER_IDEMPOTENCY_CONFLICT` instead of replaying — fail-closed, never a wrong replay; keys are short-lived retry tokens, no stored Offer changes |
| D-P61-2 | Medium | m28/index.mjs agent projection | verify Ana, share an Offer with her, set her FIFA facet INACTIVE, read the projection | 200 with terms | 403, nothing readable until re-verified | an agent without a current licence kept reading employment terms; the route's own comment said the licence was consulted | `client_private` is unregulated in P5.6E so `decide` never asked; the route relied on that decision alone | `licenceCurrentFor` exported on the P5.6E seam; consulted at read; fail-closed when the seam is absent | hardening C4–C5; m23AgentIntegrationE2E, m23AgentE2E, m23AgentFinalHardeningE2E, m23AgentComplianceE2E green | fixed | yes | none (a read that should not have been answered is now refused; nothing stored changes) |
| D-P61-3 | Medium | m28/offer.mjs `cleanText` | put U+202E (right-to-left override) in a role | stored and rendered, so the term could read differently in different apps | stripped like other control characters | a term that looks different to the club and the recipient | the control-character class stripped C0/C1 only | bidi (U+202A–E, U+2066–9), zero-width (U+200B–F, U+2060–4), BOM stripped; letters kept | hardening T (pure) | fixed | yes | none (existing rows keep their bytes; new writes are clean) |
| D-P61-4 | Medium | m28/offer.mjs `offerIntegrity` | plant a revision issued before it was created, responded before issued, expiring 400 days out, numbered 0, or with a non-string pointer | read as a sound row | refused as corruption | a forged or corrupted row could read as truth | integrity checked presence and vocabulary, not ordering or bounds | five temporal rules, `revision_number` ≥ 1, pointer type | persistence 5.5–5.7; P6 suites green | fixed | yes | none for rows this server wrote (monotonic clock, validated expiry) |
| D-P61-5 | High | m28 (offer.mjs + index.mjs) case/Offer consistency | plant an ACCEPTED Offer on a case at `offer_declined`; or pause a case while a revision is out | the Offer read as accepted while the case said declined; a recipient saw a live revision as answerable on a paused case | corruption refused; a paused case read as "not answerable, case paused" | two truths at once; a recipient invited to answer what could not be recorded | no rule related an Offer's live status to its case's status | `offerCaseConsistency` (two corruption codes, one warning); `offerFor` and `soundOffer` refuse/omit; recipient `answerable` + `notAnswerableReason: 'CASE_PAUSED'` | persistence 5.8–5.9; hardening P7–P9, Z; live not needed | fixed | yes | none for P6 rows (a case moves only through the Offer's act) |
| D-P61-6 | Medium | m28/index.mjs side effects | make `broadcast` throw after an issue persisted | 500 after a persisted success — the client retried, or believed nothing happened | 200 with the persisted truth; the throw logged | a lie about a success; a retry storm | side effects called bare after `persistNow()` | `safe(label, fn)` around every broadcast/notification | hardening O2 (source) + O4–O5 replay; every suite green | fixed | yes | none |
| D-P61-7 | Medium | m28/index.mjs `advanceCase` | make the lifecycle writer throw during an accept | the Offer was mutated in memory and the handler failed — a half-written state until the next persist | the Offer rolled back; 409 `OFFER_LIFECYCLE_CONFLICT` | an ACCEPTED revision on a case that never moved | the writer's throw was not caught | try/catch → `{ applied: false, reason: 'writer_failed' }`; callers roll back | hardening O3 (source); P6 suites green | fixed | yes | none |
| D-P61-8 | Low | m28/index.mjs share-agent | end the representation, then `share: false` | 403 (no active agent) | 200, share cleared | a client could not take a share back after their agent left | the active-agent check ran for both directions | `share: false` clears without an agent | hardening C8–C9 | fixed | no | none |
| D-P61-9 | Medium | server.mjs / m28 player deletion | a player who answered an Offer deletes their account | their name stayed on the response row and history lines; new revisions could be drafted about them | names nulled; subject marked removed; no new write | personal data kept after deletion; a club drafting to a person who left | m28 was not on the `onPlayerDeleted` hook chain | `m28Ctx.onPlayerDeleted` wired after m26's | m23OfferE2E X, hardening (deletion path exercised by the persistence journey) | fixed | yes | none (no deletion had happened with an Offer present before P6.1) |
| D-P61-10 | Medium | m28/offer.mjs `offerIntegrity` | plant `currentRevisionId` at revision 1 while revision 2 is ISSUED | sound; `currentRevision` and `liveRevision` disagreed | refused (`current_revision_not_latest`) | two revisions each "current" to a different reader | the pointer was checked for existence only | the pointer must be the latest revision unless every later one is a WITHDRAWN (discarded) draft | persistence 5.5 (rof-t6); P6 accept-vs-supersede still green | fixed | yes | none |
| D-P61-11 | Medium | m28/index.mjs recipient/agent lists, m23/journey.mjs | plant a case/Offer disagreement; list as the recipient, the agent, or read the journey | the row was listed (and a read receipt was written on it) | omitted, nothing written | a recipient shown an Offer the club's case contradicts | the lists checked row integrity only | `soundOffer` (integrity + player match + consistency) in both lists; the journey filter | persistence 5.7, 5.22 | fixed | yes | none |
| D-P61-12 | Low (test) | scripts/m23OfferPersistence.mjs | run after D-P61-4 | 2.12 and nine dependants failed: revision 2 was issued with a test clock earlier than the revise that created it | a monotonic clock | a false corruption signal in the suite | the `issue` helper pinned `at(T0)` | revision 2 issued at T0+H | 94 checks green | fixed | no | none |
| D-P61-13 | Low (test) | scripts/m23OfferHardeningE2E.mjs, e2e/m23OfferHardeningLive.test.mjs | first runs | SSE frames are `data: {"event":…}` not `event:` lines; the journey timeline keys history by target status (moves must be counted from the room's raw activity); `revise` carries no expiry (by design); a case that reached a terminal state was reused; the UTC-day assertion had its instants inverted; no second agency in the seed; race pairs were started while building the argument list (before the stream and the counters were in place); the player app has no `/` tab and can log in only as four players | exact counts and deterministic fixtures | none in product | test-side | fixtures reassigned (one player per terminal outcome), a second agency seeded before boot, race pairs as thunks, the stream settled before the race, exact `=== 1` counts | 243 / 48 green | fixed | no | none |
| D-P61-14 | Medium | scoutbox-player `M23Offer` | leave the Offers tab open; the club pauses the case (or withdraws / revises); return to the tab | the screen showed the Offer exactly as before, with an Accept control on a revision the server would refuse; nothing told the player the case was paused | the list re-read on every return to the tab; the paused state named in the player's own language with no answer control | stale UX: an invitation to act on a state that no longer exists (the server refused it, so no data was ever wrong) | the tab keeps the screen mounted, so the effect that reads the list ran only on mount and after the player's own act; the API's `notAnswerableReason` was never rendered | `useFocusEffect` bumps a tick that re-runs the read; a `CASE_PAUSED` line (EN/FR, typed) and no control while paused | live S3h–S3l; hardening P6.5–P10b (API); 5/5 typechecks; demos rebuilt, freshness 16/16 | fixed | no (server-side the act was already refused) | none |

## Totals

| Severity | Found | Fixed | Open |
| --- | --- | --- | --- |
| Critical | 0 | 0 | 0 |
| High | 2 | 2 | 0 |
| Medium | 9 | 9 | 0 |
| Low | 3 (1 product, 2 test-side) | 3 | 0 |

Known P6.1 flakes: 0. Every re-run followed a code or test fix; no
suite failed twice for the same reason, and none passed on retry without
a change.

## Harness incident (not a defect, disclosed)

`m23AgentComplianceE2E` (P5.6C, untouched by P6.1) threw `server did
not come up` once in the final confirmation lane, immediately after the
fresh-clone lane's five builds: its 40 s boot window expired under load.
No assertion failed; the suite passed 346/346 in the battery, in the
post-fix regression and on a re-run with no change. Recorded in
M23_P61_OFFER_TEST_REPORT.md §10–§11.

## Not defects (decisions recorded)

- **Expiry is the handler's instant.** A request "started before expiry"
  is one whose server instant precedes it; there is no client timestamp
  to honour (E10).
- **Events stay org-private.** Recipients hear through notifications;
  no player stream carries an Offer event (P6 §35, re-proven L/M).
- **Withdraw with a newer unissued draft withdraws the draft only** and
  leaves the issued revision live (P6 L; hardening F4 on the issued
  revision).
- **After a decline the club must step the case back**
  (`shortlist` → `considerOffer`) before a new Offer (E2E X; the
  hardening fixtures do exactly that).
- **No delete route** for an Offer: withdrawal is the closure act, and
  the record is the club's own.
- **The read receipt is recorded on list** because the list shows the
  full terms (P6 §40).
- **A wall-clock step backwards** is outside the temporal model (see
  M23_P61_OFFER_LEGACY_COMPATIBILITY.md §3).
