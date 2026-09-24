# M23 P6.1 — Offer workflow hardening & adversarial closure: final report

Branch: `claude/desktop-project-migration-wyk3ec`
Starting tip (frozen P6): `b84e5c0` — local and remote
Final functional tip: `bebdaad` (R4)
Final local tip: the R5 commit that carries this report (docs only; its
hash and the final bundle's SHA256 are stated in the delivery message)
Remote tip: `b84e5c0` — unchanged; nothing was pushed
Ahead/behind: 5 / 0 after R5
Tree: clean after R5
Schema: 2307 — Migration: none

P6.1 commits (never amended, rebased or squashed):
R1 `3d4ee0f` server hardening + server suites · R2 `6423089` browser
hardening suite, exact race counts, subject deletion · R3 `32f6145`
documentation set + defect register · R4 `bebdaad` player app names a
paused case and re-reads Offers on focus; paused-case checks
unconditional · R5 this report, the test report, the readiness gate, the
completed defect register and a corrected legacy-document sentence.

Recovery bundles (each `b2eca8e..tip`, delivered with its SHA256, none
pushed): R1 `930cfdba…37a7`, R2 `bb5fcf1e…930e`, R3 `92d97b7b…32a8`,
R4 `12953437…13e20`, final R5 bundle `b84e5c0..tip` — SHA256 in the
delivery message, verified from a disposable clone.

## The 88 items

| # | Item | Result |
| --- | --- | --- |
| 1 | Attack surface | documented: 14 routes, 9 actor classes, the inputs read and the inputs never read, side effects and audiences, 15 threats each closed (M23_P61_OFFER_ATTACK_SURFACE.md) |
| 2 | Concurrency | 17 races, one authoritative result each, exact counts (M23_P61_OFFER_CONCURRENCY_MATRIX.md; hardening F/P/G; probe) |
| 3 | Expiry | −1 ms lands, 0 ms and +1 ms refused, at the handler's single server instant (E1–E4, E10; live S2) |
| 4 | Lazy expiry | derived on read from a stored ISSUED row; no write, no job (E7–E9; persistence 5.2–5.4) |
| 5 | Stale club role | demoted lead refused before a key replay; restricted room removes the read (G13–G17, B1–B4) |
| 6 | Stale org membership | 401 on read/mutation/read-by-id; open SSE silent (A1–A6) |
| 7 | Stale agent representation | terminated → `REPRESENTATION_NOT_ACTIVE`; nothing readable (C11–C12; live S4) |
| 8 | Agent licence recheck | consulted at every read; lapse closes, re-verify restores (C4–C5; D-P61-2) |
| 9 | Same-agency privacy | colleague, admin, analyst, foreign agency: 404 with no Offer word (I1–I3; live S4h–S4i) |
| 10 | Block matrix | every transition (M23_P61_OFFER_BLOCK_MATRIX.md; D1–D16) |
| 11 | Deep-link revocation | revoked agent, same agency, stale editor (live S1, S4) |
| 12 | Notification privacy | factual line + id across five inboxes; colleague never notified (L1–L5) |
| 13 | Event privacy | six org-private events, ids + status word; no player stream carries one (L/M pure, F1b, P1–P5) |
| 14 | Idempotency | 14 questions answered (M23_P61_OFFER_IDEMPOTENCY_RATELIMIT_AUDIT.md) |
| 15 | Nested fingerprint | deep canonical; different terms under one key conflict (G11; D-P61-1) |
| 16 | Rate-limit aliasing | one budget per org / per person; replay unpenalised; closure never starved (H1–H8) |
| 17 | Revision integrity | ordering, bounds, numbering, statuses (persistence 5.5; D-P61-4) |
| 18 | Current revision pointer | must be the latest unless the later one is a discarded draft (persistence 5.5 rof-t6, 5.14; D-P61-10) |
| 19 | Cross-offer | a revision id from another Offer: 404 (J2) |
| 20 | Cross-case | a foreign transaction id: 400; the case's own 404 for a foreign club (J4–J5) |
| 21 | Cross-player | the wrong player's body claims: 404 (T1); player mismatch refused (`offerFor`, `soundOffer`) |
| 22 | Cross-org | a key at another org is independent; a foreign id byte-identical to an invented one (G10–G12, J1) |
| 23 | Case/Offer consistency | corruption refused, warning surfaced, recipient told CASE_PAUSED (persistence 5.8–5.9; P6.5–P10b; D-P61-5, D-P61-11) |
| 24 | Draft leakage | a draft is invisible to every recipient and agent (L5; P6 A5c) |
| 25 | Internal note leakage | none (sentinel sweeps I/L/N/T/V/Z, live N10) |
| 26 | P5 rationale leakage | none (same sweeps) |
| 27 | Transaction leakage | none (S_TX sentinel; J4) |
| 28 | Document authorization | by Offer id, issued revisions only; guessed ids 404 (J3, T3) |
| 29 | Legacy lifecycle | `offer_made` with no Offer row: nothing fabricated, nothing movable (Q1–Q4b; persistence 5.10–5.13) |
| 30 | Direct writer audit | `recruitmentOffers` written by m28 only; status by m17's writer only (source sweeps) |
| 31 | Partial failure | authoritative state → persist → `safe()` effects; writer throw rolled back (O1–O5; D-P61-6, D-P61-7) |
| 32 | Persistence corruption | nine planted rows refused/omitted, never repaired (persistence §4–§5) |
| 33 | Temporal corruption | issued-before-created, responded-before-issued, out-of-bounds expiry, future/unknown instants fail closed (E/R pure; persistence 5.5) |
| 34 | Minor fail-closed | every jurisdiction incl. prototype keys; GB 18 / KR 19 on a UTC day; corrupt DOBs (S-p1–S-p10; V3) |
| 35 | Client trust | body-supplied authority ignored (T source sweep, T1–T2, F7) |
| 36 | Error oracle | byte-identical 404s; allowlisted fields; 24 codes (J1; T pure) |
| 37 | Audit provenance | one history line, one audit row per winning act; recipient acts named by kind (F1c, P1–P5) |
| 38 | Notification duplication | exactly one per act; replays add none (F1d, G3, P1–P5) |
| 39 | Event duplication | exactly one `offer_issued` / `offer_responded` per act (F1b, P1–P5) |
| 40 | Inbox duplication | no second inbox: notifications with the Offer id as `refId` (P6 V/W; L1) |
| 41 | Large input | 20 MB body limit; per-field limits; oversize 400 (T pure) |
| 42 | XSS | no `dangerouslySetInnerHTML`; HTML inert (T pure) |
| 43 | Deletion/tombstone | names nulled on the stored row, record kept, no new draft (Y1–Y10; D-P61-9) |
| 44 | Transaction readiness | re-evaluated at issue; codes only (P6 T; J4) |
| 45 | Policy change | none needed: no policy stored on the Offer; every read re-derives (C3–C7) |
| 46 | Representation change | scope, licence, block, affiliation, termination (C3–C12) |
| 47 | Withdrawal lifecycle | issued revision → WITHDRAWN, case back to consideration; draft-only withdrawal leaves the live one (F4, P4–P5; live S5) |
| 48 | Supersession lifecycle | exactly one live revision in every order (P6, F2–F3; live S3) |
| 49 | Draft race | one logical Offer per case (F8–F9) |
| 50 | Revision race | one draft, contiguous numbers (F5–F5b) |
| 51 | Stale UX | conflict sentence, superseded, paused, withdrawn named in the apps; Offers re-read on focus (live S1/S3/S5; D-P61-14) |
| 52 | Accessibility | labelled controls, aria-required/describedby, polite live region, two-step accept/decline, text + glyph states, six widths (test report §7) |
| 53 | EN/FR | club 2312/2312, grassroots 2190/2190; player +1 typed key; no raw code rendered |
| 54 | m23OfferHardeningE2E | 259 checks, 181 negative, green |
| 55 | m23OfferE2E | 447, green |
| 56 | m23OfferPersistence | 94 (41 negative), green |
| 57 | m23TemporalIntegrityE2E | 493, green |
| 58 | Agent regressions | m23AgentIntegrationE2E 535, m23AgentE2E 407, m23AgentFinalHardeningE2E 286, m23AgentComplianceE2E 346, m23AgentTransactionE2E 404 — green (one harness boot-timeout incident on the compliance suite, re-run green with no change; disclosed) |
| 59 | Full server battery | 42 rows (41 suites + apiE2E), 42 rc 0, 0 failures, 8,190 checks counted |
| 60 | apiE2E | 130/130 |
| 61 | Browser battery | 16 suites, 0 failures, 0 page errors |
| 62 | Browser hardening | m23OfferHardeningLive 53 checks, 26 negative, 0 page errors |
| 63 | Typecheck | 5/5 |
| 64 | Build/export | 5/5 (player via `expo export`) |
| 65 | Perf/load | m23OfferPerf audit + m23Perf, m23ContactPerf, m23TrialPerf, m23DecisionPerf, m22Robustness 48, m22Blocker 60 — green; no N+1 |
| 66 | Clean boot | 2307 on an empty store; 17 migrations once; ports released |
| 67 | Replay | second boot 0 migrations, data persisted, 0 duplicate registrations; keys replay after SIGKILL and SIGTERM |
| 68 | Fresh clone | from `bebdaad`, nothing reused: install, 2307, cold boot, 5/5, 5/5, five server suites, both live journeys — green (test report §9) |
| 69 | Listeners after tests | only the container's own (2024, 2025, 39717, 45183 — kernel console, Claude CLI, environment manager) |
| 70 | Critical found/fixed | 0 / 0 |
| 71 | High found/fixed | 2 / 2 (D-P61-1 fingerprint, D-P61-5 case/Offer consistency) |
| 72 | Medium found/fixed | 9 / 9 (D-P61-2, 3, 4, 6, 7, 9, 10, 11, 14) |
| 73 | Low found/fixed | 3 / 3 (D-P61-8 product; D-P61-12, D-P61-13 test-side) |
| 74 | Open Critical | 0 |
| 75 | Open High | 0 |
| 76 | Open reasonably-fixable Medium | 0 |
| 77 | Open relevant Low | 0 |
| 78 | Known flakes | 0 P6.1 flakes; one harness incident disclosed (test report §11) |
| 79 | Signing writers added | none |
| 80 | db.signings writer added | none |
| 81 | signed writer added | none |
| 82 | under_contract writer added | none |
| 83 | Pushed | no — remote tip b84e5c0 |
| 84 | PR | none |
| 85 | Deployment | none |
| 86 | Product expansion | none: no counteroffer, negotiation, ranking, pay-to-play, new minor pathway, new navigation |
| 87 | Hardening tests weakened an invariant | none: every fix strengthened a rule; no test was passed by relaxing tenant isolation, block semantics, the age gate, agent privacy, same-agency privacy, the rev, idempotency, temporal fail-closed or decision/transaction privacy |
| 88 | Documents | 12/12 M23_P61_OFFER_* complete |

## Truth block

Starting tip: b84e5c0 · Remote starting tip: b84e5c0

P6.1 Offer Hardening complete: **YES**

Offer issue race produces one authoritative result: YES
Accept vs decline race produces one authoritative result: YES
Accept vs withdraw race produces one authoritative result: YES
Expiry boundary deterministic: YES
Lazy expiry safe without background job: YES

Stale Club role can mutate Offer: NO
Removed org member can mutate Offer: NO
Expired/terminated Agent retains access: NO
Expired Agent licence retains Offer access: NO
Same-agency unrelated Agent retains access: NO
Agency admin automatically sees Offer: NO
Old deep link bypasses current authorization: NO

Draft Offer leaks outside Club: NO
Internal notes leak: NO
P5 rationale leaks: NO
Transaction private data leaks: NO
Offer documents leak: NO

Nested idempotency terms collapse to same fingerprint: NO
Idempotency replay performs a new unauthorized mutation: NO
Rate-limit aliases create extra abuse budgets: NO

Stale currentRevision pointer trusted: NO
Cross-offer revision confusion possible: NO
Cross-case confusion possible: NO
Cross-player confusion possible: NO
Cross-org hidden Offer leaks metadata: NO

Unknown Offer status fails open: NO
Malformed expiry fails open: NO
Corrupt persisted Offer widens access: NO
Future/corrupt timestamp makes Offer valid forever: NO
Case/Offer inconsistency is silently exposed: NO

Minor Offer pathway newly opened: NO
Minor Agent pathway newly opened: NO
Guardian fail-closed preserved: YES
P5.7 temporal helpers preserved: YES

Offer acceptance creates db.signings: NO
Offer acceptance sets signed: NO
Offer acceptance sets under_contract: NO
Signing workflow implemented: NO

m23OfferHardeningE2E passed: YES · m23OfferE2E passed: YES ·
m23OfferPersistence passed: YES · m23TemporalIntegrityE2E passed: YES ·
Full server battery passed: YES · apiE2E passed: YES · Browser battery
passed: YES · Five-app typecheck passed: YES · Five-app build/export
passed: YES · Perf/load passed: YES · Clean boot passed: YES · Replay
passed: YES · Fresh clone passed: YES · Recovery bundle created: YES

Open Critical: 0 · Open High: 0 · Open reasonably-fixable Medium: 0 ·
Open security/privacy/authorization/data-integrity Low needing repair: 0 ·
Known P6.1 flakes: 0 (one harness boot-timeout incident in a P5.6C
suite disclosed; re-run green with no change)

P6.1 pushed: NO · PR created: NO · Deployment performed: NO

## Conclusion

M23 P6.1 OFFER WORKFLOW HARDENING COMPLETE — frozen locally at the R5
tip named in the delivery message; ready for M23 P7 signing & contract
completion, which remains entirely unstarted.
