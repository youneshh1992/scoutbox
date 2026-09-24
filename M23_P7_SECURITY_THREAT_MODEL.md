# M23 P7 — Signing security threat model

Threats considered, the control that closes each, and where it is proven.
Numbers are the mandate's adversarial cases (§83, #1–#50); letters are
m23SigningE2E groups; "live" is m23SigningLive.

## 1. Fabricated or premature signings

| Threat | Control | Proof |
| --- | --- | --- |
| Offer acceptance creates a signing / a row / `signed` / `under_contract` | acceptance touches m28 only; the signing surface is empty afterwards; the evidence rule needs a row | B3, B4, #2, #21; live A3b |
| a package started over a non-accepted, stale, declined or withdrawn Offer | `canStart` (Offer + revision ACCEPTED, case `offer_accepted`); binding to a stale revision is corruption | B1, B2, AD3, #1, #7 |
| a party's acknowledgment alone writes `signed` | no lifecycle call outside the completion; the evidence rule needs the row | D12, J5, L4, #22, #26 |
| an uploaded executed document completes the signing | it is evidence only; the gate needs every party | J2, #17 |
| completion with a missing party, a wrong digest, invalid evidence | `completionGate` | I1, A28–A31, #16 |
| the club names `signed` by hand; the legacy status writer | 422 evidence required | L1, L2, X3 |
| a legacy `signed` history fabricates a package or evidence | nothing is backfilled; legacy rows are reported as such | X4, persistence 1 and 4.10, #49 |
| duplicate completion (replay, second key, restart, race) | idempotent per package; `completedRowFor`; gate `CONFLICTING_COMPLETED_SIGNING`; single-threaded store | K7, K8, Z9, Z10, P group, #20, #31, #32, #47 |
| half-written completion after a crash between stores | snapshot + rollback unit of work; development fault seams | AD12–AD14, #48 |

## 2. Wrong actor

| Threat | Control | Proof |
| --- | --- | --- |
| a scout / member opens, presents, cancels, signs, completes | `roomCan`, `isLead` per request | C1, C5, C9, C10, I2, N2 |
| a room lead signs for the club | `isLead` only | C9 |
| a foreign club reads or acts | org-scoped lookup → 404 | C2, C3, G9, N3 |
| another player reads or signs a package | `forEntityId` on the party; recipient lookup by player → 404 | D3, G13, N11b, #9 |
| an agent, an agency admin, a same-agency colleague signs or reads beyond the share | no write route; `PARTY_ACTOR_KINDS`; own agreement + basis + scope + licence + share | D7, F5, F7, F8, D4, D5, #10–#13 |
| a guardian signs for an adult; a minor pathway opens | dormant guardian routes; pathway table closed; `SIGNING_PATHWAY_CLOSED` | E1–E4, F4, #14, #15 |
| stale role, stale session, old deep link | authority re-derived per request; 401/403; the agent app's deep link shows no access | C12, U3, U5, live E, #37, #38 |
| the body names an actor, a timestamp, a method | the session is the actor; the server clock is the clock; only `PLATFORM_ACKNOWLEDGMENT` | D9, Y6, #43 |

## 3. Document and evidence tampering

| Threat | Control | Proof |
| --- | --- | --- |
| two different files with one digest | exact-bytes SHA-256 (D-P7-1), recomputed independently of the vault | G5, G6, #21 |
| the presented document is swapped in place | DRAFT-only attach; supersede creates a revision; a completed package is immutable | G11, K9, #18, #19 |
| a confirmation against a superseded revision or a different digest | `canCompleteParty` names the revision and the digest | H4, H5, D4, A25, A26 |
| a tampered record (party before ready, completed before parties, org actor on a player party, pointer at an old revision, reference mismatch) | `signingIntegrity` + `signingConsistency` on read and write; omitted, refused, never repaired | A34–A40, AD1–AD3, persistence 4 (ten planted rows), #5, #6, #45, #46 |
| a random file completes a signing | mime/magic/size validation in m14; evidence only | G3, J2 |

## 4. Disclosure

| Threat | Control | Proof |
| --- | --- | --- |
| a draft or unpresented revision leaks | absent from every recipient/agent payload | A41, B10, G8, #8 |
| the internal note, the decision, the Offer note, a signatory name, the digest reach a recipient or an agent | audience-specific views; sentinel sweeps | A42, D2, F4, T group, live B2e, D3b, N10, #39 |
| a foreign or invented id reveals existence | one concealment body | G14, #41, #42 |
| terms or documents in generic events / notifications | ids and the party type only; texts name acts | V1, V3, W group, #40 |
| a 500 leaks internals | `publicErrorBody` allowlist; 500 bodies carry code + message only | A10, AD12 |

## 5. Availability and abuse

| Threat | Control | Proof |
| --- | --- | --- |
| flooding starts, uploads, confirmations, closures | four rate policies (`signing_start`, `signing_document_write`, `signing_party_completion` per actor, `signing_closure`) | rate registry test; AA-p6/p7 shape |
| oversized note / label / reason, bidi spoofing | `cleanText` limits and control stripping | A43 |
| impossible dates, expiry outside 1 h–90 d, eleven-year contracts | `validateContractDates`, `validateExpiry` | A13, Y2–Y5, #44 |
| client clock skew widening authority | the test-clock header is honoured only under `SCOUTBOX_TEST_CLOCK=1`; bodies never carry instants | Y6 |
| fault seams reachable in production | the fault layer exports nothing usable under `NODE_ENV=production`; `SCOUTBOX_FAULTS` there is a fatal config problem | m182E2E, capabilities |

## 6. What P7 does not defend against, by design

- Compromise of a party's own account: a `PLATFORM_ACKNOWLEDGMENT` proves the authenticated account confirmed; account security is the platform's (M18.1 login rate limits, session tokens), not the signing's.
- Legal standing of the acknowledgment in a given jurisdiction: not claimed (§103).
- A club uploading a document that is not the agreement the player believes it is: the digest proves what was confirmed, the player app shows the file; reading it is the player's act.
