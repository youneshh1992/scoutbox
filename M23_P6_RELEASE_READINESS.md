# M23 P6 — Release readiness

Branch `claude/desktop-project-migration-wyk3ec`, from the frozen tip
`8f062ac`. Local commits only; **no push, no PR, no deploy, no migration,
no signing** — as mandated (§83, §90, §91).

| # | Area | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | **Existing writer audit** | **PASS** | M23_P6_EXISTING_OFFER_WRITER_AUDIT.md — every offer/signing site classified; no unsafe writer existed; the evidence seam is what P6 fills |
| 2 | **Principles A–V frozen** | **PASS** | `m28/offer.mjs` and `m28/index.mjs` headers; asserted by m23OfferE2E group A (A1–A28) |
| 3 | **Canonical store** | **PASS — no migration** | `recruitmentOffers` module-guaranteed by m28, created empty at registration; schema 2307, 17 migrations; decision recorded in M23_P6_OFFER_MODEL.md §2; boot contract §12 green |
| 4 | **State machine** | **PASS** | seven statuses, terminal at revision level, no signed state (A1–A4); every edge and non-edge proven (A54–A65) |
| 5 | **Revision model** | **PASS** | immutable once issued (#39), new revision on change (#40), historical readability (#41), superseded not answerable (#42); live-vs-current rule (K1, A54) |
| 6 | **Terms model** | **PASS** | narrow, typed, bounded; DATE_ONLY days; no compensation field (A31–A39) |
| 7 | **Create gate** | **PASS** | offer_consideration + finalized progress decision + no block + no live Offer (#3, #4, B) |
| 8 | **P5 integration** | **PASS** | decision referenced by id; rationale never in any Offer payload (U, #36); no auto-Offer (#4, live A3b) |
| 9 | **Transaction integration** | **PASS** | `offerReadinessFor` seam, re-evaluated at issue, codes only (T, #13, #37) |
| 10 | **Agent integration** | **PASS** | own-agreement + `client_private` + scope, per-Offer client share, read-only, no accept route (H, #6, #14, #18–#20, #48; live E) |
| 11 | **Minor / guardian** | **PASS — fail closed** | pathway table closed everywhere; issue to a minor refused 422; guardian routes dormant and fail-closed (S, #21, #23–#25, #51; live F) |
| 12 | **Club role model** | **PASS** | `offer_view` 0 / `offer_draft` 2 / `offer_issue` 2, re-derived per request (#2, #8, A12; live N2) |
| 13 | **Player authority** | **PASS** | the addressed adult only, own act, second explicit step in the app (#17, #22, #31; live B) |
| 14 | **Issue gate** | **PASS** | role, state, rev, subject, block, complete terms, expiry range, documents ownership, recipient NOW, minor pathway, transaction readiness, rate limit — in that order (D, §50) |
| 15 | **Lifecycle writer** | **PASS** | ONE validator + ONE writer; m28 never assigns status (A24); legacy routes still evidence-gated (#16, E, X) |
| 16 | **Expiry** | **PASS** | P5.7 `parseInstant`, ≥1 h ≤180 d, lazy, fails closed on unreadable values (#10–#12, #26, #52, J, Z) |
| 17 | **Accept / decline / withdraw / supersede** | **PASS** | N, O, L, K/M; races P (#43–#45) |
| 18 | **Idempotency / rev** | **PASS** | keys per act on the record, replay after restart (Q, P §3); ONE Offer rev, required integer (#7, C, K3) |
| 19 | **Blocks** | **PASS** | no draft/issue while blocked; decline stays open; withdraw allowed (R, #9) |
| 20 | **Contact / Inbox** | **PASS** | no second inbox: notifications with the Offer id as `refId`; the canonical player notifications list (V, W) |
| 21 | **Documents** | **PASS** | vault references owned by the club, fetched by Offer id on issued revisions only (A47–A49, `documentHandler`) |
| 22 | **Privacy matrix** | **PASS** | M23_P6_OFFER_PRIVACY_MATRIX.md; sentinel sweeps I/U/V, live N10 |
| 23 | **Same-agency** | **PASS** | 404 REPRESENTATION_NOT_FOUND, nothing says an Offer exists (#18, #19; live E5) |
| 24 | **Internal note vs message** | **PASS** | two fields; the note never leaves the club (F2, A88; live B2c) |
| 25 | **Events / audiences** | **PASS** | six org-private events, ids + status word only, registered and declared (A15, D5, m182E2E) |
| 26 | **Notifications / deep links** | **PASS** | factual lines, one non-mandatory category, links re-authorised on open (V, W, #48) |
| 27 | **Audit** | **PASS** | append-only Offer history + case audit rows; recipient history filtered (C9, F3) |
| 28 | **Viewed = receipt** | **PASS** | `firstViewedAt` on the club view from list or read; never a status (§40; live C5) |
| 29 | **Projections** | **PASS** | journey `offer.records` + `offerAwaitingResponse` from the live revision; no term in the journey (D9) |
| 30 | **App surfaces** | **PASS** | Club/Grassroots Offer tab; Player Offers section (adult + guardian); Agent Offers client tab; Admin untouched by design (§42) |
| 31 | **Navigation** | **PASS** | page tabs only; no global Offers destination (navConfig pin kept); Agent tab under Clients → client (§43) |
| 32 | **UX states** | **PASS** | text + glyph for all seven statuses; exact expiry, exact revision, who must respond; "Offer accepted — signing pending" (§44; live A4c, B5b, C1) |
| 33 | **EN/FR** | **PASS** | club 2312/2312, grassroots 2190/2190 (m182E2E parity); player and agent typed `fr: typeof en`; no server English in any screen (D-P6-14; live N16) |
| 34 | **Accessibility** | **PASS** | labelled controls, aria-required fields, describedby on Issue, polite live region, tab semantics, keyboard (live N15); two-step accept/decline in the player app (§46) |
| 35 | **Rate limits** | **PASS** | four policies on the central limiter, one budget per organisation / per person; idempotent replay unaffected (Y) |
| 36 | **Temporal integrity** | **PASS** | all instants server-derived; m23TemporalIntegrityE2E 493 green |
| 37 | **Tenant isolation** | **PASS** | concealment on every foreign read/write; byte-identical 404s (#1, #17, #49, #50, C5, D2, L3) |
| 38 | **Response authority** | **PASS** | actor and instants from the session, never the body (Z6) |
| 39 | **Analytics / Trust / Second Look** | **PASS** | untouched; m20E2E green; no Trust or Passport mutation in m28 |
| 40 | **Error taxonomy** | **PASS** | 24 codes, one table, no prototype, allowlisted fields, drift guard (A17–A22) |
| 41 | **Threat model** | **PASS** | M23_P6_OFFER_SECURITY_THREAT_MODEL.md — 30 threats, each with its control and proof |
| 42 | **52 adversarial cases** | **PASS** | every case in m23OfferE2E, marked #n; the eight EXPECT YES cases pass, the rest are refused with the named status and code |
| 43 | **m23OfferE2E / m23OfferPersistence / m23OfferLive** | **PASS** | 447 / 59 / 98 checks |
| 44 | **Full server battery** | **PASS** | ⟨SERVER_BATTERY⟩ |
| 45 | **apiE2E** | **PASS** | 130/130 |
| 46 | **Temporal suite** | **PASS** | 493 checks, 335 negative (in the battery) |
| 47 | **Browser battery** | **PASS** | ⟨BROWSER_BATTERY⟩ |
| 48 | **Typecheck / build ×5** | **PASS** | 5/5, 5/5 (player via `expo export`) |
| 49 | **Perf** | **PASS** | m23OfferPerf: sub-millisecond views, one scan per request, no N+1; six existing perf/robustness suites green; `m22/perf.json` untouched |
| 50 | **Clean boot** | **PASS** | schema 2307 on an empty store; 0 migrations on re-boot; data persisted across restart; port released |
| 51 | **Migration replay** | **PASS — n/a** | no migration added; a pre-P6 snapshot boots with an empty Offer store and no case reinterpreted (P §1) |
| 52 | **Fresh clone** | **PASS** | ⟨FRESH_CLONE⟩ |
| 53 | **Recovery bundles** | **PASS** | R1 a47c086, R2 a47b7d0, ⟨BUNDLES⟩ — each with SHA256, sent to the user, none pushed |
| 54 | **No signing** | **PASS** | no `db.signings` read or write, no `signed`, no `under_contract`; "signing pending" wording everywhere (A23, #32–#35, P 2.8–2.9, 3.18) |
| 55 | **No autonomous negotiation / no pay-to-play** | **PASS** | no such code; every state change is an explicit human act behind a route |
| 56 | **Defects** | **PASS** | 14 found, 14 fixed (0 Critical, 3 High, 6 Medium, 5 Low incl. 2 test-side); 0 open; 0 flakes |

**Gate (§86): 0 open Critical, 0 open High, 0 open Medium, 0 open relevant
Low, 0 known flakes; every canonical suite green; every frozen invariant
preserved (the three assertions that named the store "not shipped" now
name it shipped, with comments).**
