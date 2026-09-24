# M23 P7.1 — Signing hardening release readiness

The §91 gate, item by item, with the evidence behind each line. "Green"
means the harness printed zero failures at the tip named in
M23_P71_SIGNING_TEST_REPORT.md (R4 `b8be874`; functional code last changed
in R3 `adcd397`).

## 1. The gate

| Requirement | State | Evidence |
| --- | --- | --- |
| Open Critical | 0 | M23_P71_SIGNING_DEFECT_REGISTER.md — none found |
| Open High | 0 | D-P71-1 (bytes verification) and D-P71-2 (evidence rule) fixed R1 |
| Open reasonably-fixable Medium | 0 | D-P71-3, -5, -11, -12 fixed R1 |
| Open security / privacy / authorization / data-integrity Low needing repair | 0 | D-P71-4, -6, -7, -8, -9, -10, -13 fixed R1/R3 |
| Known P7.1 flakes | 0 | every lane first-run green at R4 |
| All signing regressions green | yes | hardening E2E 211, signing E2E 255, persistence 119, hardening live 68, signing live 134 |
| All platform regressions green | yes | server battery 45 / 45, browser battery 18 / 18, apiE2E 130 / 130 |

## 2. The §94 conditions, each with its proof

| Condition | Proof |
| --- | --- |
| Signed document substitution is not possible | hardening B3–B17, J9; live E2–E3; persistence 5.1 |
| Document digest mismatches fail closed | hardening C1–C6, B6–B9 |
| Required-party corruption cannot complete signing | hardening D1–D12, A9–A11 |
| Stale club, player, agent and guardian authority cannot sign | hardening E3–E5, F1–F5, G7–G12, H1–H5; live A4–A5, F6–F7 |
| Signing deep links reauthorize current access | live A, C, D, F; hardening L8, O group |
| Signing completion races produce one authoritative result | hardening J1–J13 (M23_P71_SIGNING_CONCURRENCY_MATRIX.md) |
| Duplicate completion cannot create duplicate db.signings | hardening J1, J11–J12, P12; persistence 5.2, 5.7d–e |
| Idempotency cannot become a signing capability token | hardening L7–L9 |
| Stale revision data cannot overwrite current signing state | hardening M1–M4, J10; live B3 |
| Package, Offer, player, case and org references cannot be confused | hardening N1–N4, O1–O7, P group |
| Signing, case, contract, affiliation and completion state remain consistent | hardening P1–P15; persistence 5.2–5.5 |
| Partial failures do not produce successful inconsistent signing state | hardening Q1–Q6 (M23_P71_SIGNING_PARTIAL_FAILURE_MATRIX.md) |
| Restarts do not duplicate completion | persistence 5.7a–5.7e, 3.13 |
| Corrupt or malformed temporal signing data fails closed | hardening S1–S12, R group |
| Signing documents, internal notes and contract terms remain private | hardening T1–T7, U2, V2–V3, Y2, G3; live D9, N10 |
| Legacy signed states do not fabricate signing evidence | hardening W1–W5; persistence 4.10, 5.5 |
| Trust Score remains independent of signing | hardening ZP; P7 K13, Z6 |
| Offer acceptance still does not create signing or signed state | hardening ZA, ZL, ZC; P7 B3–B4 |

## 3. What is delivered

- Server: byte verification of the signing document at present, party
  completion, completion and serve; the evidence rule for `signed` coupled
  to the named package; eleven integrity codes for party and evidence
  tampering and far-future expiry; four consistency codes coupling the
  package to `db.signings` and a divergence warning for the player's
  declared contract status; a party-completion unit of work with rollback
  and a development fault seam; per-Offer uniqueness in the writer; the
  safety-closure rate budget; two refusal-code refinements; the present
  route's ordering.
- Clients: the agent's signing line prefers the live package. No new
  strings; no new navigation.
- Suites: m23SigningHardeningE2E (new), m23SigningPersistence section 5,
  m23SigningHardeningLive (new), the P7 pure fixture and the perf fixture
  aligned with the new rules.
- Documents: the twelve §88 files.

## 4. What is deliberately not delivered (stated, not hidden)

- No migration (schema stays 2308); no amendment, renewal, rescission,
  post-completion void, external e-signature, AI signing, negotiation,
  agent-for-player signing or minor pathway (§90).
- The legacy recording route keeps its P7 shape (a caller of the ONE
  writer, refused beside an Offer or a package); its retirement is a
  product decision.
- The player's self-declared contract status stays writable; divergence
  from a completed signing is detected, not repaired.
- Membership removal has no route in this build; role drift is proven
  through the login-time role update, membership loss through the
  platform's `USER_REMOVED` guard.

## 5. Operational notes

- The `internal:` fault rules exist only outside `NODE_ENV=production`;
  a production boot with `SCOUTBOX_FAULTS` set is a fatal configuration
  problem, as before.
- Byte verification hashes at most one 8 MB file per act; no index or cache
  was added.
- No push, no PR, no deploy were performed; the branch is local commits
  R1–R5 over `a1ad89e` with bundles and SHA-256 in the final report.

## 6. Verdict

Every line of the §91 gate holds at R4 `b8be874` and the documentation
commit R5 changes no code. **P7.1 is ready for M23 P8 full recruitment
journey integration.** Nothing has been pushed, no PR opened, nothing
deployed.
