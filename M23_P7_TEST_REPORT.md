# M23 P7 — Test report

Every lane the mandate names (§84–§99), what ran, at which tip, with the
counts as the harness printed them. Scratchpad logs are named in brackets.

## 1. The three P7 suites

| Suite | Tip | Checks | Negative | Result | Log |
| --- | --- | --- | --- | --- | --- |
| `scoutbox-server/scripts/m23SigningE2E.mjs` | R4 `75dc6cb` | 255 | 154 (60%) | green, 0 failures | p7r4-m23SigningE2E.log; battery run 2 |
| `scoutbox-server/scripts/m23SigningPersistence.mjs` | R4 | 84 | — | green | p7r4-m23SigningPersistence.log; battery run 2 |
| `e2e/m23SigningLive.test.mjs` | R3 `4889e22` / R4 (browser battery) | 134 | 48 (36%) | green, zero page errors | p7-live-run6.log; p7-seq-m23SigningLive.log |

### m23SigningE2E groups (§84) and the 50 adversarial cases (§83)

A model/store (pure: statuses, gates, integrity, consistency, views, text
limits, error table) · HTTP fixture · B start gate (#1 #2 #8) · C club
authority (#3 #4 #37) · G documents (#8 #19 #21 #41 #42) · D player
authority (#9 #10 #22 #43) · E guardian/minor (#14 #15) · F agent (#10–#13)
· I/J/K parties, evidence, completion (#16 #17 #20 #22–#26 #40 #47 #50) ·
H revisions (#18 #30) · L lifecycle (#22 #26 #27) · P concurrency (#31 #32)
· Q idempotency (#34 #35 #36) · R expiry (#29 #33) · S blocks · T/U
privacy, oracles, deep links, authority loss (#37 #38 #39 #41 #42) · V
events (#40) · X legacy (#49) · Y temporal (#43–#46) · AD adversarial
closure (#5 #6 #7 #28 #48) · Z boundary sweep and restart (#23 #24 #25 #47
#50). Every case #1–#50 is labelled in the suite by number.

### m23SigningPersistence sections (§85, §89)

1 the migration 2307 → 2308 exactly once, fresh boot 2308, replay applies
nothing, no fabrication · 2 a real journey (DRAFT, READY, IN_PROGRESS,
COMPLETED, CANCELLED, VOIDED, SUPERSEDED packages; keys; parties; evidence
refs; document hash) survives SIGTERM and a reboot byte-faithfully · 3
after the reboot: identical views, keys replay, completion refused,
`db.signings` uniqueness, lifecycle consistency, player contract state,
audit/events · 4 ten planted corrupt rows are named, refused, omitted,
never repaired; a legacy signed case fabricates nothing.

### m23SigningLive groups (§86)

A club opens (readiness, explicit start, contract days, note, file upload,
independent SHA-256, present) · B player signs at 390 px (exact revision,
digest, parties, no note, two-step confirmation, IN_PROGRESS, nothing in
`db.signings`) · C club completes (club signature under own name, explicit
completion, Signed, under_contract, no second package, legacy route refused,
player reads completion) · D agent read-only under the shared Offer (no
note, digest, name or control; same-agency 404; no write route) · E revoked
agent deep link (app shows no access; API refuses) · F minor fail-closed
(no Offer to a minor, readiness names the pathway, forced request refused,
guardian lists nothing) · G cancel with a reason (Offer unchanged) · N scout
read-only, foreign 404, player 401, other player 404 · widths 1440 / 1280 /
1024 / 768 / 390 / 360 with the status pill inside the viewport and no
horizontal scroll · N15 tab semantics, every control labelled, two
aria-required inputs, `aria-describedby` on Present, a polite live region,
keyboard input · N16 FR on the club tab and the player section · N10
sentinel sweeps over pages and APIs · zero page errors across every context.

## 2. Regression suites named by the mandate

| Suite | Checks | Result |
| --- | --- | --- |
| m23OfferHardeningE2E (Offer hardening) | 259 | green |
| m23OfferE2E | 447 | green |
| m23OfferPersistence | 94 | green |
| m23TemporalIntegrityE2E (Temporal) | 493 | green |
| m23AgentIntegrationE2E (Agent integration) | 535 | green |
| m23AgentE2E / Compliance / Transaction / FinalHardening | 407 / 346 / 404 / 286 | green (after the superseded 2307 / event truths were updated test-side, T-P7-4) |
| m23DecisionE2E, m23TrialE2E, m23ContactE2E | 435 / 535 / 428 | green |

## 3. Full server battery (§90)

Lane `p7-battery.sh`: 43 suites plus apiE2E = **44 rows** (P6.1 baseline
42). Run 1 at R3 + working tree: 39 green, 4 rows failing on superseded
truths (m182E2E grassroots catalogue; three suites pinned to schema 2307 or
to "no signing event") — all four are test-side or product-parity items
fixed in R4 (D-P7-5, T-P7-4). Run 2 at the final functional tip:
see §3b.

### 3b. Battery run 2 (final functional tip R4 `75dc6cb`)

**44 / 44 green, 0 failures, 0 flakes** (`p7-battery-run2.status`):

| Suite | Checks | | Suite | Checks |
| --- | --- | --- | --- | --- |
| m23SigningE2E | 255 | | m23P4AClosureE2E | 337 |
| m23SigningPersistence | 84 | | m23ContactE2E | 428 |
| m23OfferHardeningE2E | 259 | | m23ContactPersistence | 61 |
| m23OfferE2E | 447 | | m23TrialE2E | 535 |
| m23OfferPersistence | 94 | | m23TrialPersistence | 36 |
| m23TemporalIntegrityE2E | 493 | | m23DecisionE2E | 435 |
| connectedE2E | 43 | | m23DecisionPersistence | 48 |
| m12E2E | 152 | | m23AgentE2E | 407 |
| m13E2E | 212 | | m23AgentPersistence | 68 |
| m14E2E | 194 | | m23AgentComplianceE2E | 346 |
| m141E2E | 94 | | m23AgentCompliancePersistence | 83 |
| m15E2E | 190 | | m23AgentTransactionE2E | 404 |
| m16E2E | 118 | | m23AgentTransactionPersistence | 63 |
| m161E2E / m162E2E / m181E2E | green | | m23AgentIntegrationE2E | 535 |
| m17E2E / m18E2E / m19E2E / m20E2E / m21E2E | 17 / 18 / 19 / 20 / 21 | | m23P56ERepairAudit | 179 |
| m182E2E | 418 (green) | | m23AgentFinalHardeningE2E | 286 |
| m22E2E | 112 | | testTrust | green |
| m23E2E / m23Persistence / m23BootContract | 2 / 67 / 57 | | apiE2E | 130 |

(The lane's count regex prints the last "N checks" line a suite emits;
m161/m162/m181/m182/m23E2E emit a different final line — their own logs
show their full counts, e.g. m182E2E 418.) The server the battery started
for apiE2E was reaped at the end (one pid), and the listener set afterwards
is the container's own.

## 4. apiE2E (§91)

130 / 130 API checks against a real server with `DATA_DIR` on both sides
(run 1 and run 2).

## 5. Browser battery (§92)

Lane `p7-seq.sh`, sequential, **17 suites, 17 green** (P6.1 baseline 16),
at R4 `75dc6cb`:

| Suite | rc | Checks |
| --- | --- | --- |
| m23SigningLive | 0 | 134 (48 negative) |
| m23OfferHardeningLive | 0 | 53 |
| m23OfferLive | 0 | 98 |
| navConfig | 0 | 359 |
| m15Live | 0 | 21 |
| m12Live | 0 | green (no count line) |
| m21Live | 0 | 68 |
| m23AgentGrassrootsLive | 0 | 49 |
| m23AgentLive | 0 | 90 |
| m23AgentComplianceLive | 0 | 86 |
| m23AgentTransactionLive | 0 | 116 |
| m23AgentIntegrationLive | 0 | 98 |
| m23ContactLive | 0 | 82 |
| m23TrialLive | 0 | 122 |
| m23DecisionLive | 0 | 86 |
| m23Live | 0 | 39 |
| navLive | 0 | 64 |

Zero page errors is asserted inside every live suite (each fails on the
first `pageerror`). Ports released: the listener set after the lane
(`[2024 2025 36281 37395]`) is the container's own, identical to the set
before the lane and to the P6.1 record; no suite port survived.

## 6. Five-app typecheck and build (§93, §94)

`p7-apps.status`: typecheck agent / club / grassroots / admin / player
5 / 5 rc=0; build agent / club / grassroots / admin (vite) and export player
(expo web) 5 / 5 with an `index.html`; `buildDemos` rc=0; `demoFreshness`
16 / 16.

## 7. EN / FR (§95)

Club: 136 new keys (`rm.tab.signing`, `sg.*`, `confirm.*Signing*`) present
twice (EN and FR). Player: 22 top-level `signing*` keys, FR typed as
`typeof en` so the compiler enforces parity. Agent: 13 `signing.*` keys
twice. Grassroots: the 6 confirmation pairs mirrored. Live N16 / N16b
render the club tab and the player section in French with no English
fallback. No raw backend error code reaches a screen: every `SIGNING_*`
code maps to a sentence (`sg.err.*`, `signingErr_*`) with a generic
fallback.

## 8. Accessibility (§96)

Live N15 (tab `aria-selected`/`aria-controls`, every control labelled,
`aria-required` on the start day and the document, `aria-describedby` on
Present / Sign for the club / Complete / Start, a polite live region for
every outcome, keyboard input); status is text + glyph (○ ➤ ◐ ✓ ⊘ ⊗ ⌛ ↻)
never colour alone; the three states "Accepted in ScoutBox — signing
pending", "Presented — awaiting signatures" and "Signing completed" are
distinct words on the club header, the club pill, the player pill and the
agent pill; the player's confirmation box is `accessibilityRole="alert"`
and the message a polite live region; the digest is carried in full on an
accessibility label.

## 9. Perf / load (§97)

`scripts/m23SigningPerf.mjs` (p7-perf): every view is a fraction of a
millisecond and grows with the package's own revisions; the recipient list
and the room surface grow linearly with the store (5 000 packages: 0.05 ms
and 0.07 ms); one linear scan of `signingPackages` per surface, Offers and
cases read once per surviving package; no N+1 for the list, party states,
document metadata or the agent projection; no index or cache added. The
P6 Offer perf and the M23 perf probes were unchanged.

## 10. Clean boot / replay (§98)

`p7-coldboot.sh`: boot 1 on an empty store reports schema 2308; store
files present; a 30 February open-trial refused (400) and a real day
accepted (201); port released after stop; boot 2 reports 2308, the record
persisted, the migration ledger applied nothing on replay; no duplicate
registration; the one registry warning (`room_decision_finalized` /
`room_decision_superseded` listed but never emitted) predates P7 (P6 and
P6.1 logged the same line) and is unchanged. Re-run at the final functional
tip R4 (`p7-coldboot2.out`): identical results — 2308 on both boots, replay
applied nothing, port released twice, 0 duplicate registrations.

## 11. Fresh clone (§99)

`p7-freshclone.sh` from the final functional tip R4 `75dc6cb` into an
empty directory (nothing carried: 0 `node_modules`, 0 `dist*`, 0 db files;
node v22.22.2, npm 10.9.7), `p7-freshclone.out`:

| Step | Result |
| --- | --- |
| install (server, e2e, then each app) | rc=0 ×7 |
| schema declared | `SCHEMA_VERSION = 2308`, 18 migrations |
| boot on a cold store | `/health` ok, `X-ScoutBox-Schema: 2308`, store files created, port 4141 released after stop |
| five typechecks | 5 / 5 rc=0 |
| five builds / export | 5 / 5 with `index.html` |
| m23SigningE2E | all checks passed |
| m23SigningPersistence | all checks passed |
| m23OfferHardeningE2E (Offer hardening) | all checks passed |
| m23TemporalIntegrityE2E (Temporal) | 493 checks passed |
| m23AgentIntegrationE2E (Agent integration) | 535 checks passed |
| one Club → Player signing journey + one revoked-Agent signing deep-link journey | m23SigningLive 134 checks passed (groups A–C and E) |
| cleanup | no live surviving server / suite / chromium / vite process |

## 12. Flakes

Every suite above passed on its first run at the tip it reports. Earlier
red runs of the live suite and the E2E suite were assertion or fixture
mistakes, each fixed once and recorded in M23_P7_DEFECT_REGISTER.md
(T-P7-5, T-P7-7, T-P7-8). Known P7 flakes: 0.
