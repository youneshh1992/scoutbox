# M23 P6.1 — Offer hardening test report

Every suite below ran against the working tree at the commit named in
its section; the final confirmation runs (§10) are at the final
functional tip. Nothing was skipped, nothing was marked flaky, and no
assertion is `status !== 200`: every refusal names its status and code.

## 1. The P6.1 suites

| Suite | Checks | Negative | Content |
| --- | --- | --- | --- |
| `scoutbox-server/scripts/m23OfferHardeningE2E.mjs` (new) | **259** | 181 (70%) | pure: expiry boundary −1/0/+1 ms, unknown statuses, temporal corruption (E/R, 37); minor fail-closed in every jurisdiction incl. prototype keys, adult boundary GB 18 / KR 19 on a fixed UTC clock, corrupt DOBs (S, 32); notification category, event audiences and payloads, rate scopes, the source sweep for body-supplied authority, `dangerouslySetInnerHTML`, the 24 codes, bidi stripping, Unicode kept, oversize refused (L/M/T, 11). HTTP on a real server with the test clock and a second agency seeded: expiry over HTTP (E, 12); issue/edit/withdraw/revise/stale-rev/forged-field/two-draft races (F, 16); accept-vs-accept, decline-vs-decline, accept-vs-decline, accept-vs-withdraw, decline-vs-withdraw, accept-vs-supersede with exactly one response row, one `offer_responded` event and one case move each (P, 18); idempotency incl. same key different payload and cross-org (G, 12); idempotency after authority loss — a promoted then demoted lead, restricted room (G/B, 9); removed staff (A, 6); representation loss, same-agency sweep, foreign agency, commercial-only scope, temporal fail-closed, licence lapse and restore, client block, un-share, affiliation end, termination (C/I/K, 22); the block matrix at every transition (D, 17); hidden-resource oracle byte-identical, cross-offer, cross-case, cross-org (J, 12); legacy states (Q, 5); partial failure (O, 4); paused case: hold, surface warning, recipient told CASE_PAUSED, accept refused with nothing recorded, resume returns to review and the Offer stays unanswerable (P, 7); rate limits (H, 8); spoofed authority and documents (N/T, 4); grassroots (V, 4); notification privacy across five inboxes (L, 3); subject deletion (Y, 10); SIGKILL restart (Z, 6) |
| `scoutbox-server/scripts/m23OfferPersistence.mjs` (extended) | **94** (was 59) | 41 | §1–§4 as P6, with a monotonic test clock; **§5 (35)**: lazy expiry across a restart; seven planted temporal/status/pointer corruptions each refused on read and on write, omitted from the recipient list; an ACCEPTED Offer on a declined case refused and the case unmoved; a legacy `offer_made` case with no Offer row: no fabrication, no draft, no acceptance, nothing for the player; the latest-revision pointer of a sound multi-revision Offer; a share and the same-agency rule across a second restart; no planted row repaired, reordered or dropped by two boots and two stops |
| `e2e/m23OfferHardeningLive.test.mjs` (new; Chromium; club, player and agent apps; ports 4029/8729/8829/8929) | **53** | 26 | S1 stale rev: Save refused with the conflict sentence, the colleague's change kept, the editor reloads with it; S2 an Offer issued in the past reads ⌛ Expired at 390 px with no control, the API says `OFFER_EXPIRED`, the stored status is ISSUED; S3 revision 2 issued behind Kola's screen: the stale accept is refused and named, the app shows revision 2 and lists revision 1 as replaced, then the case is paused: the app says so, no control, `OFFER_LIFECYCLE_CONFLICT`, resume; S4 a revoked agent's deep link shows no term and says why (`REPRESENTATION_NOT_ACTIVE` behind it), Bea's same deep link shows nothing (`REPRESENTATION_NOT_FOUND`); S5 a withdrawal during the accept confirmation at 360 px: "The club withdrew this Offer.", the row re-reads Withdrawn, nothing accepted, the case back at consideration; widths 1440/1280/768/390/360 with no horizontal scroll and the pill in the viewport; sentinel sweeps; 0 page errors |
| `scoutbox-server/scripts/m23OfferE2E.mjs` (P6, unchanged) | 447 | 284 | principles A–V and the 52 adversarial cases still green under the new integrity, fingerprint and licence rules |
| `scoutbox-server/scripts/m23OfferPerf.mjs` (P6, unchanged) | audit | — | club view p50 sub-millisecond at 1/10/20 revisions; one linear scan per request; `recruitmentOffers` read 4 times across three surfaces; no N+1; no index justified |

### The accept-vs-accept probe

A standalone probe (one server, Okafor's case, two accepts in
`Promise.all`) confirmed what the suite then asserted for every race:
`200` + `409 OFFER_ALREADY_RESPONDED`; the club stream carried exactly
`connected, offer_responded, notify`; the case activity gained exactly
`case_offer_accepted` and `room_status_changed → offer_accepted`.

## 2. Server battery (§83)

41 server suites (39 existing + `m23OfferHardeningE2E` + the extended
persistence suite) and apiE2E, each on its own random port with
`DATA_DIR` set, sequentially, with no live suite running beside the lane:

| Suite | Result |
| --- | --- |
| m23OfferHardeningE2E | green — 243 at the time of the lane (259 after groups Y and P were completed; §10) |
| m23OfferE2E | green — 447 |
| m23OfferPersistence | green — 94 |
| m23TemporalIntegrityE2E | green — 493 |
| connectedE2E | green — 43 |
| m12E2E 152 · m13E2E 212 · m14E2E 194 · m141E2E 94 · m15E2E 190 · m16E2E 118 · m161E2E 79 · m162E2E 142 · m17E2E 17 · m18E2E 18 · m181E2E 196 · m182E2E 399 · m19E2E 19 · m20E2E 20 · m21E2E 21 · m22E2E 112 · testTrust (no per-check line) | all green |
| m23E2E 382 · m23Persistence 67 · m23BootContract 57 · m23P4AClosureE2E 337 · m23ContactE2E 428 · m23ContactPersistence 61 · m23TrialE2E 535 · m23TrialPersistence 36 · m23DecisionE2E 435 · m23DecisionPersistence 48 | all green |
| m23AgentE2E 407 · m23AgentPersistence 68 · m23AgentComplianceE2E 346 · m23AgentCompliancePersistence 83 · m23AgentTransactionE2E 404 · m23AgentTransactionPersistence 63 · m23AgentIntegrationE2E 535 · m23P56ERepairAudit 179 · m23AgentFinalHardeningE2E 286 | all green |
| apiE2E | green — 130/130 |

**42 rows, 42 `rc=0`, 0 failures, 8,190 passing checks counted** (the
lane's count parser under-reads six suites; their ✓ lines were counted
separately: m161E2E 79, m162E2E 142, m181E2E 196, m182E2E 399, m23E2E
382; testTrust emits none). After the lane the reap found one server
process of its own apiE2E run and nothing else.

## 3. apiE2E (§84)

130/130 against a real server with `DATA_DIR` set on both sides.

## 4. Perf / load (§85)

| Suite | Result |
| --- | --- |
| m23OfferPerf | audit green: one scan per request, 4 reads across three surfaces, no N+1, no index |
| m23Perf, m23ContactPerf, m23TrialPerf, m23DecisionPerf | "measured, not tuned", rc 0 |
| m22Robustness | 48 checks green |
| m22Blocker | 60 checks green |

`m22/perf.json` untouched. Repeated idempotent mutations are answered
before the limiter and before any scan of the rev (G3–G4, H8).

## 5. Browser battery (§88)

Sequential lane (`KEEP_DIST=1`, ports read from `/proc/net/tcp`), the
P6 battery plus the two Offer suites first:

| Suite | Checks |
| --- | --- |
| m23OfferHardeningLive | green — 48 at the time of the lane (53 after S3h–S3l; re-run green at R4 with rebuilt bundles) |
| m23OfferLive | green — 98 |
| navConfig 359 · m15Live 21 · m12Live · m21Live 68 · m23AgentGrassrootsLive 49 · m23AgentLive 90 · m23AgentComplianceLive 86 · m23AgentTransactionLive 116 · m23AgentIntegrationLive 98 · m23ContactLive 82 · m23TrialLive 122 · m23DecisionLive 86 · m23Live 39 · navLive 64 | all green |

**16 suites, 16 `rc=0`, 0 failures, 0 page errors** (every suite's
page-error line is "no page errors"). Listeners after the lane:
`2024 2025 39717 45183` — resolved through `/proc/net/tcp` inodes to the
container's own processes (the kernel console ports, the Claude CLI and
the environment manager); no suite port was held.

## 6. Typechecks, builds, demos (§86, §87)

5/5 typechecks (agent, club, grassroots, admin, player), 5/5 builds
(vite ×4, `expo export` for the player), `index.html` present each.
`e2e/buildDemos.mjs` rebuilt after the player edit; `demoFreshness`
16/16.

## 7. EN/FR (§78) and accessibility (§77)

m182E2E parity: club 2312/2312, grassroots 2190/2190 (P6.1 added no
club or grassroots key). Player: one key added in EN and FR
(`offerPaused`); the dictionary is typed `fr: typeof en`. Agent: no key
added; a 403 from the projection maps to the app's own `http.forbidden`
sentence whatever the code. No app renders a raw server code: the
player's `errMsg` falls back to `offerErr_generic` for any code it does
not know; the club's `offerErrMessage` to `of.err.generic`.

Accessibility (live suites): every control in the editor labelled,
`aria-required` on the two issue-required fields, `aria-describedby` on
Issue, a polite live region that carries the conflict sentence (S1c),
tab semantics, keyboard input (P6 N15); the player's accept and decline
are two explicit steps with the consequence sentence in an alert region
and a Not-now cancel (P6 B3–B4b); the expired, superseded, withdrawn and
paused states are text + glyph, never colour alone (`⌛ Expired`,
`↻ Replaced by a newer revision`, `⊘ Withdrawn by the club`, the paused
sentence); the agent projection carries no accept control (P6 E4);
widths 360/390/768/1024/1280/1440 with no horizontal scroll (P6 N13,
P6.1 W).

## 8. Clean boot, restart, replay (§90)

Cold boot on an empty store: `X-ScoutBox-Schema: 2307`, `scoutbox.db`
created, 17 migrations applied once; an impossible day refused (400), a
real one accepted (201); port 4177 released after stop; second boot:
2307, **0 migrations applied**, data persisted; 0 duplicate
registrations in either boot log; port released. The one registry line
in each boot log (`room_decision_finalized`, `room_decision_superseded`
listed but not seen by the source scanner) is a pre-existing P5
informational warning present in the P6 cold-boot logs too; it is not a
duplicate and not a P6.1 change. Idempotency across a restart:
hardening Z3–Z4, persistence 3.7–3.12.

## 9. Fresh clone (§91)

From the final functional tip `bebdaad` (R4), into an empty directory, with nothing reused (0 carried `node_modules`, 0 `dist` directories, 0 `.db` files — counted):

| Step | Result |
| --- | --- |
| clone | tip bebdaad = source tip; clean |
| install (server, e2e, five apps) | rc 0 each |
| `SCHEMA_VERSION` declared | 2307, 17 migrations |
| cold boot on an empty store | `X-ScoutBox-Schema: 2307`; `scoutbox.db` created; port 4141 released after stop |
| five typechecks | 5/5 rc 0 |
| five builds (player via `expo export`) | 5/5, `index.html` present each |
| `m23OfferE2E` | all checks passed (447), rc 0 |
| `m23OfferHardeningE2E` | all checks passed (259), rc 0 |
| `m23OfferPersistence` | all checks passed (94), rc 0 |
| `m23TemporalIntegrityE2E` | 493 checks, 335 negative, rc 0 |
| `m23AgentIntegrationE2E` | 535 checks, 281 negative, rc 0 |
| one real Club → Player Offer journey (`m23OfferLive`) | 98 checks, 30 negative, rc 0 |
| one revoked-agent deep-link journey, plus stale rev, expiry, supersession, paused case, same-agency and withdrawal race (`m23OfferHardeningLive`) | 53 checks, 26 negative, rc 0 |
| survivors | no live server, suite, chromium or vite process (13 already-exited zombies awaiting reap, holding nothing) |

The docs-only commit R5 (this report, the readiness gate, the defect register, the final report and a corrected sentence in the legacy document) sits after the functional tip; no code or suite changed after `bebdaad`.

## 10. Final confirmation runs at the final functional tip

Run in the working tree at `bebdaad`, sequentially, after the fresh-clone lane:

| Suite | Result |
| --- | --- |
| m23OfferHardeningE2E | 259 checks, 181 negative, rc 0 |
| m23OfferE2E | 447, rc 0 |
| m23OfferPersistence | 94, rc 0 |
| m23TemporalIntegrityE2E | 493, rc 0 |
| m23AgentIntegrationE2E | 535, rc 0 |
| m23AgentE2E | 407, rc 0 |
| m23AgentFinalHardeningE2E | 286, rc 0 |
| m23AgentComplianceE2E | first run: the harness threw `server did not come up` after 134 pure checks — its 40 s boot window (160 × 250 ms) expired while the machine was still loaded from the fresh-clone lane's five builds; no assertion failed. Re-run without any change: 346 checks, rc 0 (§11) |
| m23AgentTransactionE2E | 404, rc 0 |

Listeners after everything: `2024 2025 39717 45183` — the container's own processes (kernel console ports, the Claude CLI, the environment manager), resolved through `/proc/net/tcp` inodes; no suite port held.

## 11. Flakes and incidents

Known P6.1 flakes: none. Every re-run of a P6.1 suite followed a code or
test fix (D-P61-1 … D-P61-14); no P6.1 suite failed twice for the same
reason, and none passed on retry without a change.

One harness incident is disclosed rather than hidden: in the final
confirmation lane, `m23AgentComplianceE2E` (a P5.6C suite, untouched by
P6.1) threw `server did not come up` before its HTTP section — the
suite's fixed 40 s boot window expired under the load left by the
fresh-clone lane, which had just built five apps. Nothing was asserted
false; the same suite had passed in the battery (346) and in the
regression run after the licence change (346); a re-run with no change
passed (346). The boot window belongs to that suite's harness; P6.1
changes no harness outside its own suites, so it is recorded here, in
the defect register's incidents note, and in the final report's truth
block.
