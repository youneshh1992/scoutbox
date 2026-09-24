# M23 P6.1 — Offer hardening release readiness

Branch `claude/desktop-project-migration-wyk3ec`, from the frozen P6 tip
`b84e5c0`. Local commits only; **no push, no PR, no deploy, no migration,
no signing** (§96, §102, §103). Evidence for every row is in
M23_P61_OFFER_TEST_REPORT.md and the document named.

| # | Area | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | **Attack surface** | **PASS** | M23_P61_OFFER_ATTACK_SURFACE.md — every route, actor, input, side effect and read-that-writes named, with its proof |
| 2 | **Invariants A–V re-proven** | **PASS** | m23OfferE2E group A (447) green under the new integrity, fingerprint and licence rules |
| 3 | **Concurrency (17 races)** | **PASS** | M23_P61_OFFER_CONCURRENCY_MATRIX.md; hardening F/P/G with exactly one winner, one response row, one `offer_responded` event, one case move, one notification; probe confirmed |
| 4 | **Expiry boundary / lazy expiry** | **PASS** | E1–E12: −1 ms lands, 0 ms and +1 ms refused, stored status stays ISSUED, reads write nothing; malformed and out-of-bounds expiry fail closed (E/R pure, persistence 5.5); live S2 |
| 5 | **Stale club role / membership** | **PASS** | G13–G17, B1–B4, A1–A6: demoted lead, restricted room, removed staff, open streams |
| 6 | **Stale agent representation / scope / licence / affiliation / block** | **PASS** | C1–C12, I1–I3; licence consulted at read (D-P61-2); temporal fail-closed (C3a); live S4 |
| 7 | **Same-agency privacy** | **PASS** | I1–I3 (colleague, admin, analyst, foreign agency) across list, per-Offer route, notifications (L2), events (org-private only), documents (no projection route); live S4h–S4i |
| 8 | **Block matrix** | **PASS** | M23_P61_OFFER_BLOCK_MATRIX.md; D1–D16 |
| 9 | **Deep-link revocation** | **PASS** | C4, C11–C12; live S4e–S4g (revoked agent), S4h (same agency); the club editor after a colleague's change (live S1) |
| 10 | **Notification / event privacy** | **PASS** | L/M pure (audiences, payload allowlists), L1–L5 across five inboxes; no player stream carries an Offer event |
| 11 | **Idempotency incl. nested fingerprint and authority loss** | **PASS** | M23_P61_OFFER_IDEMPOTENCY_RATELIMIT_AUDIT.md; G1–G17, Z3–Z4, persistence 3.7–3.12; D-P61-1 fixed |
| 12 | **Rate-limit aliasing / closure safety** | **PASS** | H1–H8 |
| 13 | **Revision integrity / current pointer** | **PASS** | integrity rules incl. `current_revision_not_latest` (D-P61-10); persistence 5.5 rof-t6, 5.14 |
| 14 | **Cross-offer / case / player / org confusion** | **PASS** | J1–J5, F7, T1–T2, G12 |
| 15 | **Case/Offer consistency** | **PASS** | `offerCaseConsistency` (D-P61-5, D-P61-11); persistence 5.8–5.9; hardening P6.5–P10b; live S3h–S3l |
| 16 | **Leakage: draft, note, rationale, transaction, documents** | **PASS** | M23_P61_OFFER_PRIVACY_HARDENING.md; sentinel sweeps I/L/N/T/V/Z, live N10; documents by Offer id on issued revisions only (J3, T3) |
| 17 | **Legacy lifecycle states / direct writers** | **PASS** | M23_P61_OFFER_LEGACY_COMPATIBILITY.md; Q1–Q4b; persistence 5.10–5.13; source sweeps |
| 18 | **Partial failure / restart** | **PASS** | M23_P61_OFFER_PARTIAL_FAILURE_AUDIT.md; O1–O5, Z1–Z6 (D-P61-6, D-P61-7) |
| 19 | **Persistence and temporal corruption** | **PASS** | persistence §4–§5: nine planted rows refused/omitted, never repaired, no case moved (D-P61-4) |
| 20 | **Unknown statuses fail closed** | **PASS** | R-p1 (pure), persistence rof-t4/t5 |
| 21 | **Minor / guardian fail-closed, adult boundary** | **PASS** | S-p1–S-p10 (every jurisdiction incl. prototype keys; GB 18 / KR 19 on a UTC calendar day; corrupt DOBs); V3 |
| 22 | **Client trust (body-supplied authority)** | **PASS** | T source sweep, T1–T2, F7 |
| 23 | **Error oracle / taxonomy** | **PASS** | J1 byte-identical; 24 codes, no prototype, allowlisted fields (T pure) |
| 24 | **Audit provenance / duplication** | **PASS** | one history line, one audit row, one event, one notification per winning act (F1b–F1d, P1–P5, G3) |
| 25 | **Large input / Unicode / bidi / HTML** | **PASS** | T pure (oversize refused, Unicode kept, bidi stripped — D-P61-3, no `dangerouslySetInnerHTML`) |
| 26 | **Deletion / tombstone** | **PASS** | Y1–Y10 (D-P61-9) |
| 27 | **Analytics / Trust / Second Look untouched** | **PASS** | m20E2E, testTrust, m22E2E green; no m28 write outside `recruitmentOffers`, case history and notifications |
| 28 | **Transaction readiness, policy and representation change** | **PASS** | J4; C3, C6–C12; P6 T group unchanged |
| 29 | **Withdrawal / supersession / draft / revision races** | **PASS** | F3–F9, P4–P6; live S3, S5 |
| 30 | **Stale UX** | **PASS** | live S1 (conflict sentence, reload), S3 (superseded, paused), S5 (withdrawn); D-P61-14 fixed |
| 31 | **Accessibility** | **PASS** | test report §7 |
| 32 | **EN/FR** | **PASS** | club 2312/2312, grassroots 2190/2190; player +1 typed key; no raw code rendered |
| 33 | **m23OfferHardeningE2E / m23OfferPersistence / m23OfferHardeningLive** | **PASS** | 259 / 94 / 53 |
| 34 | **Full server battery** | **PASS** | 42 rows (41 suites + apiE2E), 0 failures, 8,190 checks counted |
| 35 | **apiE2E** | **PASS** | 130/130 |
| 36 | **Perf / load** | **PASS** | m23OfferPerf audit + six suites green; no N+1; `m22/perf.json` untouched |
| 37 | **Browser battery** | **PASS** | 16 suites, 0 failures, 0 page errors, ports released |
| 38 | **Typecheck / build ×5** | **PASS** | 5/5, 5/5 |
| 39 | **Clean boot / replay** | **PASS** | 2307, 0 migrations on re-boot, 0 duplicate registrations, ports released |
| 40 | **Fresh clone** | **PASS** | test report §9: from the final functional tip `bebdaad`, nothing reused; install, schema, cold boot, 5/5, 5/5, Offer E2E, hardening E2E, persistence, temporal, agent integration, the Club → Player journey and the revoked-agent deep-link journey |
| 41 | **Recovery bundles** | **PASS** | R1 3d4ee0f, R2 6423089, R3 32f6145, R4 bebdaad, R5 (final) — SHA256 in the final report, none pushed |
| 42 | **No signing** | **PASS** | diff b84e5c0..tip: no `db.signings` write, no `signed`, no `under_contract`, no e-/countersignature; only negative assertions mention the words |
| 43 | **No product expansion / no minor pathway / no negotiation** | **PASS** | no new route, navigation, counteroffer, ranking or pathway; `MINOR_OFFER_PATHWAY_ENABLED` all false (S-p1) |
| 44 | **Defects** | **PASS** | 14 found, 14 fixed (0 Critical, 2 High, 9 Medium, 3 Low incl. 2 test-side); 0 open; 0 flakes |

**Gate (§98): 0 open Critical, 0 open High, 0 open reasonably-fixable
Medium, 0 open security/privacy/authorization/data-integrity Low needing
repair, 0 known flakes; every current suite green; every frozen
invariant preserved and no hardening test was made to pass by weakening
tenant isolation, block semantics, the age gate, agent privacy,
same-agency privacy, the rev, idempotency, temporal fail-closed, or
decision/transaction privacy.**
