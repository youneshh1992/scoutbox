# M23 P7.1 — Signing Workflow Hardening & Adversarial Closure: final report

Branch `claude/desktop-project-migration-wyk3ec`, from the frozen tip
`a1ad89e` (P7 R6, local = remote at Stage 0). Local commits R1–R5 only —
**no push, no PR, no deploy, no migration** — as the mandate requires
(§95, §96).

The governing principle, re-proven under retries, races, corruption,
restarts and stale access:

    A completed signing is trustworthy only if the exact signing revision,
    exact document evidence, exact required parties, exact authorization
    state, exact temporal state and every authoritative side effect remain
    coherent.

Two findings mattered most. The vault bytes were never re-read after
upload, so a swapped file, a forged digest or a borrowed evidence row could
have reached completion; every act that depends on the document now
re-hashes the bytes and checks the row is the package's own. And a
`db.signings` row planted beside a live package satisfied the lifecycle's
evidence rule for `signed`; a row that names a package is now evidence only
if that package completed with it.

## The 95 items (§92)

| # | Item | Answer |
| --- | --- | --- |
| 1 | starting tip | `a1ad89e` (local = remote, 0/0, clean) |
| 2 | final local tip | R5 = the commit that contains this file (its hash is in the delivery message; a file cannot contain its own commit's hash). R4 = `b8be874`; final functional tip R3 = `adcd397` |
| 3 | remote tip | `a1ad89e` — unchanged; `origin/main` `b2eca8e` unchanged |
| 4 | schema | 2308 before and after (18 migrations) |
| 5 | migration | none added (§85 strong preference honoured) |
| 6 | attack surface count | 29 actions, 21 mutating, 13 keyed, 11 rev-guarded, 5 rate policies, 7 events, 3 audiences + T&S (M23_P71_SIGNING_ATTACK_SURFACE.md) |
| 7 | evidence tampering result | every forged or moved evidence reference is corruption: actor, actor type, removed reference, malformed instant, foreign revision, foreign digest, foreign instant, complete-without-evidence, pending-with-evidence (hardening A1–A12; D-P71-11) |
| 8 | document substitution result | bytes swapped on disk → nothing served, no signature, no completion, no row; restored bytes → normal, no repair; in-place replace refused by state; a borrowed vault row refused; another player's document concealed (hardening B; live E; persistence 5.1; D-P71-1) |
| 9 | digest integrity | raw-byte SHA-256 (D-P7-1) re-proven; identical bytes → identical digest, one byte → different; row, revision and bytes must agree everywhere (hardening B4, C1–C6) |
| 10 | required-party corruption | empty, duplicate, unknown type, wrong player, wrong org, missing recipient or club party, guardian beside an adult, agent substituted — all refused; a persisted package with its player party removed cannot complete (hardening D1–D12) |
| 11 | stale Club role | the role is the current login's; a demoted Head's open session cannot sign, complete or void (she remains room lead of a room she opened and may cancel); restored, the same session completes (hardening E; live A) |
| 12 | stale Player identity | the session is the actor; body playerId / actor / completedAt / method ignored; another player 404 (hardening F) |
| 13 | stale Agent authority | share withdrawn, licence lapsed, agreement terminated, client's block — each closes the read at once; no write route; same-agency 404 (hardening G; live F) |
| 14 | guardian/minor | closed stays closed; a malformed, missing or future DOB is not an adult; guardian list empty, read 404, act 422/404 (hardening H) |
| 15 | deep-link revocation | every open re-derives: demoted lead's tab, revoked agent's client tab, cancelled/voided/expired/superseded packages in the player app (live A, C, D, F; hardening O) |
| 16 | concurrency matrix | 18 races, one winner each (M23_P71_SIGNING_CONCURRENCY_MATRIX.md; hardening J) |
| 17 | completion vs cancel | one 200, one 409; never COMPLETED + CANCELLED (hardening J2) |
| 18 | completion vs void | one 200, one 409; never COMPLETED + VOIDED (hardening J3) |
| 19 | completion vs expiry | decided by the mutation's server instant; 1 ms before lands, at the instant refused; lazy, no cron (hardening K1–K8) |
| 20 | idempotency | replay for the same actor/key/payload; conflict on a different payload or actor; authority before replay; keys per package (hardening L) |
| 21 | rev | stale `expectedRev` is 409 on ready, club-sign, cancel, void, supersede, complete, executed-document; missing or non-integer is 400 (hardening M; live B) |
| 22 | cross-package | a revision id is meaningful only in its own package: 400 in another, 404 across players, DOCUMENT_NOT_FOUND on a foreign revision (hardening N) |
| 23 | cross-offer | a package rebound to another Offer is corruption (`OFFER_REFERENCE_MISMATCH`); rebound back, readable, nothing repaired (hardening O6–O7) |
| 24 | cross-player | player, package, Offer and case identity must agree; no client field changes the player (hardening F, O, P7 #5–#6) |
| 25 | cross-org | real hidden id and invented id byte-identical for read, document, cancel, void, supersede, complete, start (hardening O1–O5) |
| 26 | case/signing consistency | COMPLETED without a row, a row without completion, duplicate rows, a completion naming an absent row → corruption named on the surface, never repaired, never fabricated; a case edited to signed beside a live package is named (hardening P5–P15, W3; D-P71-12) |
| 27 | under_contract consistency | the player's declared status contradicting a completed signing → `PLAYER_CONTRACT_STATUS_DIVERGED` warning, nothing overwritten; a completed package without under_contract is the same signal (hardening P2–P4; D-P71-13) |
| 28 | affiliation consistency | the grassroots squad row is written inside the unit of work and rolled back with it; a Pro signing writes none; the release route's `free_agent` is a separate act, documented (M23_P71_SIGNING_LEGACY_COMPATIBILITY.md) |
| 29 | invoice/level duplication | inside the unit of work, idempotent per package and per Offer; a refused duplicate changes neither (hardening J, Q; P7 O1, P6b) |
| 30 | partial failure | fifteen points classified; four seams proven: party after-write (new), completion after row, after lifecycle, after effects (M23_P71_SIGNING_PARTIAL_FAILURE_MATRIX.md; hardening Q; D-P71-5) |
| 31 | restart recovery | interrupted before persistence → nothing; after persistence → converges on replay to one row and a signed case (persistence 5.7) |
| 32 | persistence corruption | unknown status, missing revision, stale currentRevision, duplicate revision number, malformed party, missing evidence, malformed expiresAt, completedAt before createdAt, wrong org, wrong player, duplicate completion record — fail closed on read and write, the process boots, nothing repaired across five restarts (hardening R; persistence 4–5) |
| 33 | temporal corruption | malformed createdAt / readyAt / completedAt / expiresAt, expiry beyond the maximum, expiry before creation, revision before package, presented before created, impossible contract days, a party instant edited into the future — all corruption; no authority widened (hardening S; D-P71-11) |
| 34 | MIME/content mismatch | m14 sniffs magic bytes: PDF extension + other bytes, declared PDF + HTML → refused; dangerous names refused regardless of bytes (m14 rules; P7 G3) |
| 35 | file-size safety | 8 MB vault limit; 20 MB JSON body limit before any code runs; one hash per act, bounded by the vault limit |
| 36 | filename/path safety | traversal and separators refused; the stored name is the vault id; the original name is metadata sliced to 120 (m14 rules) |
| 37 | XSS | labels and notes are `cleanText`-bounded and rendered as text in every app; zero page errors with a `<script>`-free but bidi-bearing corpus (P7 A43; live) |
| 38 | bidi/control chars | stripped from labels, notes, reasons; names not over-sanitised (P7 A43) |
| 39 | internal note leakage | absent from player, guardian, agent payloads, events, notifications, analytics and document metadata (hardening G3, T5, U2, V2, Y2; live D9, N10) |
| 40 | contract term leakage | no term in any event, notification, analytics row or agent projection (hardening U2, V2, Y2) |
| 41 | document auth | player, recruitment lead, club scout read; another player, foreign club, agent, agency admin 404; anonymous 401; guardian 404; no T&S document route; no vault id in the payload (hardening T) |
| 42 | document access after auth loss | the agent never had a document route or a signed URL; the generic media route serves player media only (hardening G9, T7) |
| 43 | cancellation semantics | workflow stopped before completion; history kept; the Offer and the case untouched; a new package may open (P7 L; hardening J4, C6) |
| 44 | void semantics | evidence invalidated, history kept, nothing signed; T&S void with a named reviewer and reason; refused after completion (P7 AD; hardening J3, J5; admin route) |
| 45 | supersession | the superseded revision accepts no signature and cannot complete; the new revision requires every party again, no carry-forward; told `SIGNING_SUPERSEDED` even while the new revision is a draft (hardening J6, J8; live D; D-P71-6) |
| 46 | Offer/signing boundary | acceptance creates no package, no row, no signed, no under_contract; only completion does (hardening ZA, ZL; P7 B) |
| 47 | legacy signed cases | remain legacy: no package, document, party, digest or instant fabricated (hardening W; persistence 4.10) |
| 48 | direct writer audit | `db.signings.push` and `contractStatus = 'under_contract'` in `m29/index.mjs` only; m29 never assigns `signed`; drift guard in both suites; the two other contractStatus writers named (hardening ZK/ZM/ZL; M23_P71_SIGNING_LEGACY_COMPATIBILITY.md §3) |
| 49 | Trust Score isolation | the signing module never touches it (hardening ZP; P7 K13) |
| 50 | Passport | timeline line and level only; no package, digest or note (P7 doc, unchanged) |
| 51 | analytics | rows counted; a refused duplicate does not move the count; no note, digest or term (hardening Y) |
| 52 | event privacy | seven `signing_*` events, org_private, ids + party type; registry strips the rest; the player's stream carries none (hardening U2–U3) |
| 53 | event duplication | one `signing_completed` per completion; replay and refused duplicate emit nothing (hardening U1) |
| 54 | notification privacy | factual texts, no term/digest/note/club user name to the player; agent only while the basis holds (hardening V2–V3) |
| 55 | notification duplication | a refused duplicate creates none; identical unread notifications coalesce (hardening V1) |
| 56 | Inbox | signing access implies no Inbox access; no signing act creates a system message (M23_P71_SIGNING_PRIVACY_HARDENING.md §6) |
| 57 | rate-limit aliasing | one budget per logical actor and action; party completion keyed per player / per club user; cancel/void on `signing_safety_closure` 60/h, completion on `signing_closure` 30/h (hardening X; D-P71-4) |
| 58 | client trust | the club panel's `canManage`/`canComplete` and the agent's `licensed` are server-supplied hints; every act is re-authorized server-side (live A4: a button that was shown is refused) |
| 59 | error oracle | identical concealment for foreign club, foreign player, same-agency agent, expired agent, guardian (hardening O, G, H) |
| 60 | accessibility | live A4–A5, B3, C2, D4–D8 plus the P7 N15 checks in the browser battery; text + glyph status; the agent line read-only (M23_P71_SIGNING_TEST_REPORT.md §7) |
| 61 | display drift | one `effectiveStatus` for all three surfaces; the agent shows the live package over an Offer (D-P71-7 fixed) |
| 62 | grassroots drift | no signing surface, no signing route; the confirmation catalogue mirrors the club's (m182E2E §16) |
| 63 | m23SigningHardeningE2E | 211 checks, 154 negative (73%), groups A–Z, 22 store cycles — green |
| 64 | m23SigningE2E | 255 — green |
| 65 | m23SigningPersistence | 119 (section 5 added) — green |
| 66 | m23SigningHardeningLive | 68 checks, 16 negative, six widths, zero page errors — green |
| 67 | Offer hardening | m23OfferHardeningE2E 259 + m23OfferHardeningLive 53 — green |
| 68 | Temporal | m23TemporalIntegrityE2E 493 — green |
| 69 | Agent regressions | 407 / 68 / 346 / 83 / 404 / 63 / 535 / 179 / 286 and six agent live suites — green |
| 70 | full server battery | 45 rows (44 suites + apiE2E; baseline 44), **45 / 45 green**, 0 flakes |
| 71 | apiE2E | 130 / 130 |
| 72 | browser battery | 18 suites (baseline 17), **18 / 18 green**, zero page errors, ports released |
| 73 | typechecks | 5 / 5 (working copy and fresh clone) |
| 74 | builds | 5 / 5 (working copy and fresh clone); `buildDemos` rc=0; `demoFreshness` 16 / 16 |
| 75 | EN/FR | no new strings; refined codes already in every table; live renders the refined sentences; parity holds |
| 76 | perf/load | `m23SigningPerf` at R4: fractions of a millisecond, linear in the store, one scan per surface, no N+1; one bounded hash per document act |
| 77 | clean boot | empty store → 2308, store files, port released (`p71-coldboot.out`) |
| 78 | replay | second boot 2308, record persisted, 0 migrations applied, 0 duplicate registrations; the pre-P7 registry warning unchanged |
| 79 | fresh clone | from R4 `b8be874`: install ×7, boot 2308, 5 typechecks, 5 builds, m23SigningE2E, m23SigningPersistence, m23SigningHardeningE2E, Offer hardening, Temporal, Agent integration, m23SigningLive (the real signing journey), m23SigningHardeningLive (the revoked-Agent deep-link journey) — all green, no surviving process |
| 80 | recovery bundles | R1 `586d4f0` `p71-R1.bundle` sha256 `d0c0866c9b79e2dac183be097a5b45995ba98fc03a04bbc59952c453f213b272`; R2 `436d34f` `p71-R2.bundle` `49fa60bd5329415e212c9151c7ab686ba79c8f11ea9a91a184fb1e167148a46c`; R3 `adcd397` `p71-R3.bundle` `8329508b5aaaffdc6256891436c0fe5831f8c99383f36b19688c1857597fb5df`; R4 `b8be874` `p71-R4.bundle` `0a6ea9baf215951b0145417d7d0b082cfc086b4e8d0b8102350d984f032d5935`; R5 bundle and sha256 in the delivery message. All in the session scratchpad. **DO NOT PUSH.** |
| 81 | Critical found/fixed | 0 / 0 |
| 82 | High found/fixed | 2 / 2 (D-P71-1 bytes verification; D-P71-2 evidence rule) |
| 83 | Medium found/fixed | 4 / 4 (D-P71-3 writer per-Offer uniqueness; D-P71-5 party unit of work; D-P71-11 party/evidence/expiry integrity; D-P71-12 row consistency) |
| 84 | Low found/fixed | 7 / 7 (D-P71-4 safety budget; D-P71-6 superseded code; D-P71-7 agent line; D-P71-8 P7 doc; D-P71-9 gate order; D-P71-10 present ordering; D-P71-13 divergence warning) |
| 85 | open Critical | 0 |
| 86 | open High | 0 |
| 87 | open Medium | 0 |
| 88 | open relevant Low | 0 |
| 89 | known flakes | 0 |
| 90 | tree | clean at R5 (this commit) |
| 91 | ahead/behind | 5 ahead of `origin/claude/desktop-project-migration-wyk3ec` (`a1ad89e`), 0 behind |
| 92 | pushed? | **NO** |
| 93 | PR? | **NO** |
| 94 | deployed? | **NO** |
| 95 | ready for P8? | **YES** — every gate line holds (M23_P71_SIGNING_RELEASE_READINESS.md) |

## Truth block (§93)

    Starting tip: a1ad89e
    Remote starting tip: a1ad89e

    P7.1 Signing Hardening complete: YES

    Document substitution after signature possible: NO
    Digest mismatch can complete signing: NO
    Required-party corruption can complete signing: NO

    Stale Club role can sign: NO
    Stale Player identity can sign: NO
    Expired Agent authority retains access: NO
    Same-agency unrelated Agent retains access: NO
    Old signing deep link bypasses current authorization: NO

    Completion vs cancel has one winner: YES
    Completion vs void has one winner: YES
    Completion vs expiry has one winner: YES
    Duplicate completion creates duplicate db.signings: NO

    Idempotency replay can perform new unauthorized signing act: NO
    Stale rev can overwrite current signing state: NO
    Cross-package revision confusion possible: NO
    Cross-offer confusion possible: NO
    Cross-player confusion possible: NO
    Cross-org hidden signing leaks metadata: NO

    Package COMPLETED with inconsistent case state silently exposed: NO
    under_contract can diverge from canonical signing without detection: NO
    Affiliation duplicate on retry: NO
    Invoice/level duplicate on retry: NO

    Partial failure can return success with inconsistent authoritative state: NO
    Restart can duplicate signing completion: NO
    Corrupt persisted signing widens authority: NO
    Malformed temporal data widens signing authority: NO

    Draft signing document leaks: NO
    Internal notes leak: NO
    Full contract terms leak in generic events: NO
    Signed document leaks after Agent authority loss: NO

    Legacy signed lifecycle fabricates signing evidence: NO
    Trust Score changes because Player signs: NO

    Offer acceptance creates signing: NO
    Offer acceptance writes db.signings: NO
    Offer acceptance sets signed: NO
    Offer acceptance sets under_contract: NO

    m23SigningHardeningE2E passed: YES
    m23SigningE2E passed: YES
    m23SigningPersistence passed: YES
    m23SigningHardeningLive passed: YES
    Offer hardening passed: YES
    Temporal suite passed: YES
    Agent regressions passed: YES
    Full server battery passed: YES
    apiE2E passed: YES
    Browser battery passed: YES
    Five-app typecheck passed: YES
    Five-app build/export passed: YES
    EN/FR parity passed: YES
    Perf/load passed: YES
    Clean boot passed: YES
    Replay passed: YES
    Fresh clone passed: YES
    Recovery bundle created: YES

    Open Critical: 0
    Open High: 0
    Open reasonably-fixable Medium: 0
    Open security/privacy/authorization/data-integrity Low needing repair: 0
    Known P7.1 flakes: 0

    P7.1 pushed: NO
    PR created: NO
    Deployment performed: NO

## Conclusion (§94)

The evidence above supports every line:

    M23 P7.1 SIGNING WORKFLOW HARDENING COMPLETE
    SIGNED DOCUMENT SUBSTITUTION IS NOT POSSIBLE
    DOCUMENT DIGEST MISMATCHES FAIL CLOSED
    REQUIRED-PARTY CORRUPTION CANNOT COMPLETE SIGNING
    STALE CLUB PLAYER AGENT AND GUARDIAN AUTHORITY CANNOT SIGN
    SIGNING DEEP LINKS REAUTHORIZE CURRENT ACCESS
    SIGNING COMPLETION RACES PRODUCE ONE AUTHORITATIVE RESULT
    DUPLICATE COMPLETION CANNOT CREATE DUPLICATE DB.SIGNINGS
    IDEMPOTENCY CANNOT BECOME A SIGNING CAPABILITY TOKEN
    STALE REVISION DATA CANNOT OVERWRITE CURRENT SIGNING STATE
    PACKAGE OFFER PLAYER CASE AND ORG REFERENCES CANNOT BE CONFUSED
    SIGNING CASE CONTRACT AFFILIATION AND COMPLETION STATE REMAIN CONSISTENT
    PARTIAL FAILURES DO NOT PRODUCE SUCCESSFUL INCONSISTENT SIGNING STATE
    RESTARTS DO NOT DUPLICATE COMPLETION
    CORRUPT OR MALFORMED TEMPORAL SIGNING DATA FAILS CLOSED
    SIGNING DOCUMENTS INTERNAL NOTES AND CONTRACT TERMS REMAIN PRIVATE
    LEGACY SIGNED STATES DO NOT FABRICATE SIGNING EVIDENCE
    TRUST SCORE REMAINS INDEPENDENT OF SIGNING
    OFFER ACCEPTANCE STILL DOES NOT CREATE SIGNING OR SIGNED STATE
    ZERO KNOWN CRITICAL DEFECTS
    ZERO KNOWN HIGH DEFECTS
    ZERO KNOWN REASONABLY-FIXABLE MEDIUM DEFECTS
    ZERO KNOWN SECURITY PRIVACY AUTHORIZATION OR DATA-INTEGRITY LOW DEFECTS REQUIRING REPAIR
    P7.1 IS READY FOR M23 P8 FULL RECRUITMENT JOURNEY INTEGRATION

Work stops here (§97). P8 has not been begun.
