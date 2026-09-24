# M23 P7 — Defect register

Every defect found while building and proving the signing workflow, with
the §102 fields. "Product" defects are in shipped code; "test-side" entries
are superseded truths or fixture mistakes in the suites, listed so the
record is complete. Severity follows P6.1: Critical (fabricated or lost
signing / lifecycle), High (authorization, privacy, data integrity),
Medium (correctness a user would notice), Low (honesty, wording, UX).

## Product defects

| ID | Severity | Component | Reproduction | Actual | Expected | Impact | Root cause | Fix | Regression | Status | Release blocking? | Legacy impact |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D-P7-1 | High (data integrity) | m14 `storeEvidenceFile` | attach two different binary files; compare `sha256` | the digest hashed `String(buf)` (a UTF-8 decoding), so different bytes could share a digest and a document's digest did not name its bytes | SHA-256 of the exact bytes | a party could "confirm" a digest that did not identify the file | wrong hashing input since M14 | hash the buffer (`crypto.createHash('sha256').update(buf)`); m29 recomputes the digest from the arriving bytes and refuses a mismatch | E2E G5, G6 (#21); live A8b | fixed R1 | yes | every pre-P7 evidence row's `sha256` was computed the old way; those rows are not signing documents and are not re-hashed (no reinterpretation) |
| D-P7-2 | Low (honesty) | m29 `startBlockers` | open the Signing tab on a minor's case before any Offer | readiness named only `CASE_STATE` and `OFFER_NOT_ACCEPTED` | the closed minor pathway named before anyone tries, as the Offer tab does | a lead learns of the closed pathway only after chasing an Offer that cannot be issued | the pathway check hung on an accepted revision's recipient snapshot | also check the subject with `isAdult` and the pathway table | live F2 | fixed R3 | no | none |
| D-P7-3 | Low (error taxonomy) | m29 completion route | complete a voided (or cancelled) package | `409 SIGNING_STATE_INVALID` with blockers `STATE_VOIDED` | `SIGNING_VOIDED` / `SIGNING_CANCELLED`, as every other act on that package answers | inconsistent code for one state across acts; the client's message table maps the generic code to a vaguer sentence | the gate-to-code map lacked the two terminal states | map `STATE_VOIDED` and `STATE_CANCELLED` | E2E AD6 (#28) | fixed R4 | no | none |
| D-P7-4 | Medium (data integrity) | m29 `signingConsistency` | plant a package bound to an Offer revision the Offer does not hold, or one superseded / withdrawn / declined | the package read as sound | corruption: omitted, refused, never repaired | a row this server never wrote could be read and, with forged evidence, argued over | consistency checked the Offer and the case but not the revision binding (§9, §66) | `OFFER_REVISION_MISMATCH` in `SIGNING_CORRUPTION` | E2E AD3 (#7); persistence 4 row `spk-t10` | fixed R4 | yes (as a corruption class) | none — every genuine package binds the accepted revision |
| D-P7-5 | Low (product parity) | grassroots `confirmAction.ts` / i18n | compare the club and grassroots confirmation catalogues after R3 | grassroots lacked the six signing entries and their EN/FR copy | byte-identical catalogues (m182E2E §16) | none at runtime (grassroots reaches no signing route) but the parity invariant was broken | R3 edited the club catalogue only | mirror the file and the twelve strings | m182E2E "grassroots carries the identical catalogue" | fixed R4 | no | none |

## Test-side entries (superseded truths and fixture mistakes; no product change)

| ID | Suite | What | Resolution | Commit |
| --- | --- | --- | --- | --- |
| T-P7-1 | m23BootContract | listed `signingPackages` among optional journey stores while the migration guarantees it | removed from the optional list | R1 |
| T-P7-2 | m182E2E | cancel/void event names emitted through a template string, invisible to the registry sweep | literal names | R1 |
| T-P7-3 | m23OfferE2E A10, m23OfferHardeningE2E Z6, m23OfferPersistence 1.1/1.4, m23AgentIntegrationE2E AN-p1/p2, m23TemporalIntegrityE2E T1 | schema pinned at 2307 | 2308 | R1/R2 |
| T-P7-4 | m23AgentTransactionE2E AA2/AA3, m23AgentTransactionPersistence 1–3, m23AgentFinalHardeningE2E W2b/W3 | schema pinned at 2307; "no signing event exists" written before the signing domain existed; the 2306 fixture kept the P7 migration record | 2308; the P5.6D step is the one at 2307 and the single step above it is P7's; the P7 `signing_*` events are the club's own org_private events; the fixture drops both records | R4 |
| T-P7-5 | m23SigningE2E (first runs) | `await` in a non-async callback; A3/A8 count mistakes; recipient reads used `.rev` from a player response; a placeholder completed a package; K10 ordering; S8/S9 assumed an unblock route; X3 asserted an edge the graph refuses; Z5 regex matched "designated" | fixed as fixture/assertion errors | R1 |
| T-P7-6 | m23SigningPersistence | revision 2 presented with a clock earlier than creation (the integrity rule fired correctly); a seeded `under_contract` player used as a fresh subject | helpers take the clock; fresh players | R2 |
| T-P7-7 | m23SigningLive (first runs) | asserted the note on the revision (it lives on the package); read a closed `<details>` history (innerText is empty); asserted the digest on `completion` (it is on the revision); asserted an aria-label as visible text; F2 expected a blocker the server did not yet name (became D-P7-2) | fixed | R3 |
| T-P7-8 | m23SigningE2E AD6 | asserted "no Harbour signing for Svensson" while the X group had recorded a legacy row for him at Harbour | scoped to this package's ids | R4 |
| T-P7-9 | m23SigningPerf | the 10-revision fixture completed a party before its revision was presented (integrity fired) | fixture timing | R4 |

## Totals

| Severity | Found | Fixed | Open |
| --- | --- | --- | --- |
| Critical | 0 | 0 | 0 |
| High | 1 | 1 | 0 |
| Medium | 1 | 1 | 0 |
| Low | 3 | 3 | 0 |

Known P7 flakes: 0 (every suite run in the battery, the browser battery and
the fresh clone passed on its first attempt at the final tip; the live
suite's earlier failures were assertion mistakes, each fixed once).
