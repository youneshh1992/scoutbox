# M23 P7.1 — Signing hardening test report

Every lane the mandate names (§75–§86), what ran, at which tip, with the
counts as the harness printed them. Scratchpad logs are named in brackets.
Functional code changed last in R3 `adcd397`; R4 `b8be874` changed a perf
fixture and documents, so the lanes below ran at R4 (the final tip before
R5, which is documentation only).

## 1. The three P7.1 suites and the P7 suites they extend

| Suite | Checks | Negative | Result | Log |
| --- | --- | --- | --- | --- |
| `scoutbox-server/scripts/m23SigningHardeningE2E.mjs` (new) | 211 | 154 (73%) | green | p71-h3-m23SigningHardeningE2E.log; battery |
| `scoutbox-server/scripts/m23SigningE2E.mjs` (P7) | 255 | 154 | green | battery |
| `scoutbox-server/scripts/m23SigningPersistence.mjs` (extended, §76) | 119 (was 84) | — | green | p71-pers1.log; battery |
| `e2e/m23SigningHardeningLive.test.mjs` (new) | 68 | 16 | green, zero page errors, six widths | p71-live4.log; browser battery |
| `e2e/m23SigningLive.test.mjs` (P7) | 134 | 48 | green | browser battery |

### m23SigningHardeningE2E groups (§75)

A evidence tampering (12, pure) · B document substitution on disk and by a
borrowed vault row (17, HTTP + store cycle) · C digest mismatch (6) · D
required-party corruption (13, pure + HTTP) · E club authority drift (10) ·
F player identity (5) · G agent drift (13) · H guardian/minor (6) · J
completion races (13 races, 16 checks) · K expiry (8) · L idempotency (9) ·
M rev (4) · N cross-package (4) · O cross-offer/player/org (11) · P
consistency (15) · Q partial failures (8) · R persisted corruption (12,
ten planted states) · S temporal corruption (12) · T document privacy (7) ·
U events (3) · V notifications (3) · W legacy (5) · X rate limits (5) · Y
analytics (2) · Z boundary invariants (7). The store cycle (stop, edit the
persisted store or the vault file, boot) runs 22 times in the suite.

### m23SigningPersistence section 5 (§76)

vault bytes swapped after a restart (not served, record intact, restored
without repair) · duplicate completion row · tampered evidence reference ·
completed package without its row (journey shows no signing, completion
cannot recreate it) · row naming a package that never completed (the
lifecycle by hand refused) · EXPIRED never stored across restarts · a
completion interrupted before persistence leaves nothing; one interrupted
after persistence converges on replay (one row, signed) · ten planted rows
untouched across five restarts.

### m23SigningHardeningLive groups (§77)

A stale club role under an open tab (refused by the server, controls gone
on refresh, restored and completing from the same session) · B stale rev
across two tabs (the conflict sentence; the other tab's edit intact) · C an
expired package (Expired on the club tab with "Start a new signing" and no
act; the player refused by name) · D a superseded revision after the
player signed (nothing to sign, the old confirmation refused as
superseded, revision 2 presented fresh with a different digest) · E
document immutability on the club tab (no file input, no attach, read-only
days; the API refuses) · F the agent's read-only line, same-agency 404, the
revoked deep link · W six widths on the completed case and on a two-package
case, the player app with two packages · sentinel sweeps · zero page errors.

## 2. Full server battery (§78)

Lane `p71-battery.sh` at R4: **45 rows (44 suites + apiE2E), 45 green, 0
failures, 0 flakes** (`p71-battery.status`). P7 baseline 44. Every suite the
mandate names ran: m23SigningE2E 255, m23SigningPersistence 119,
m23SigningHardeningE2E 211, m23OfferHardeningE2E 259, m23TemporalIntegrityE2E
493, the seven agent suites (407 / 68 / 346 / 83 / 404 / 63 / 535 / 179 /
286), apiE2E 130 / 130, and every other existing suite (connected 43, m12–m22,
m23 core, contact 428/61, trial 535/36, decision 435/48, boot contract 57,
P4A closure 337).

## 3. apiE2E (§79)

130 / 130 against a real server with `DATA_DIR` on both sides.

## 4. Browser battery (§80)

Lane `p71-seq.sh`, sequential, **18 suites, 18 green** (P7 baseline 17):
m23SigningHardeningLive 68 · m23SigningLive 134 · m23OfferHardeningLive 53 ·
m23OfferLive 98 · navConfig 359 · m15Live 21 · m12Live · m21Live 68 ·
m23AgentGrassrootsLive 49 · m23AgentLive 90 · m23AgentComplianceLive 86 ·
m23AgentTransactionLive 116 · m23AgentIntegrationLive 98 · m23ContactLive 82
· m23TrialLive 122 · m23DecisionLive 86 · m23Live 39 · navLive 64. Zero page
errors is asserted inside every live suite. Ports released: the listener set
after the lane (`[2024 2025 34573 46019]`) holds no suite port (4xxx / 8xxx);
the four are the container's own root-owned listeners.

## 5. Five-app typecheck and build (§81, §82)

`p71-apps.status` at R4: typecheck agent / club / grassroots / admin /
player **5 / 5** rc=0; build agent / club / grassroots / admin (vite) and
export player (expo web) **5 / 5** with an `index.html`; `buildDemos` rc=0;
`demoFreshness` **16 / 16**. Repeated in the fresh clone (§11).

## 6. EN / FR (§83)

P7.1 added no client string: the two refined refusals (`SIGNING_SUPERSEDED`
on a live package, `SIGNING_VOIDED` / `SIGNING_CANCELLED` on a refused
completion) were already in every app's message table (`sg.err.*`,
`signingErr_*`). The P7 parity check (club 136 keys ×2, player `typeof en`,
agent 13 ×2, grassroots pairs) still holds; live D6 and A4 render the
refined sentences. No raw backend code reaches a screen.

## 7. Accessibility (§72)

Live A4–A5 (a refusal announced in the polite live region, then the
controls gone), B3 (the rev-conflict sentence), C2 (Expired as text + glyph,
no act), D4–D8 (state words on the player's section), the P7 N15 checks
(tab semantics, labelled controls, `aria-required`, `aria-describedby`,
keyboard) re-run in the browser battery; no colour-only state anywhere; the
agent's line is read-only text with no control.

## 8. Display drift (§73)

Live C2 / C6 / D4 and hardening K2: one `effectiveStatus` feeds all three
surfaces; the agent shows the live package over an Offer (D-P71-7 fixed);
the player never sees the note, `rev`, an unpresented revision or a name.

## 9. Perf / load (§84)

`m23SigningPerf` at R4 (`p71-perf.log`): views in fractions of a
millisecond, linear in the store (5 000 packages: recipient list 0.05 ms,
room surface 0.07 ms), one scan of `signingPackages` per surface, Offers and
cases read once per surviving package, no N+1 for the list, detail, party
states, document metadata, the agent projection or revision history. The
byte verification adds one SHA-256 over at most 8 MB per present, party
completion, completion and document serve — bounded by the vault limit, not
by the store. No index or cache added; no auth weakened.

## 10. Clean boot / replay (§85)

`p71-coldboot.sh` at R4 (`p71-coldboot.out`): boot 1 on an empty store
reports schema **2308**, store files created, a 30 February open-trial
refused (400) and a real day accepted (201), port 4177 released after stop;
boot 2 reports 2308, the record persisted, the migration ledger applied
**0** steps on replay; 0 duplicate registrations across both boots; no new
migration, store, event or rate policy was registered twice. The one
registry warning (`room_decision_finalized` / `room_decision_superseded`
listed but never emitted) predates P7 and is unchanged.

## 11. Fresh clone (§86)

`p71-freshclone.sh` from the P7.1 tip R4 `b8be874` into an empty directory
(nothing carried: 0 `node_modules`, 0 `dist*`, 0 db files; node v22.22.2,
npm 10.9.7), `p71-freshclone.out`:

| Step | Result |
| --- | --- |
| install (server, e2e, then each app) | rc=0 ×7 |
| schema declared | `SCHEMA_VERSION = 2308`, 18 migrations |
| boot on a cold store | `/health` ok, `X-ScoutBox-Schema: 2308`, store files created, port 4141 released |
| five typechecks | 5 / 5 |
| five builds / export | 5 / 5 with `index.html` |
| m23SigningE2E | all checks passed |
| m23SigningPersistence | all checks passed |
| m23SigningHardeningE2E | all checks passed |
| m23OfferHardeningE2E (Offer hardening) | all checks passed |
| m23TemporalIntegrityE2E (Temporal) | 493 checks passed |
| m23AgentIntegrationE2E (Agent integration) | 535 checks passed |
| one real signing journey + one revoked-Agent deep-link journey | m23SigningLive 134 (groups A–C, E) and m23SigningHardeningLive 68 (groups A, F) |
| cleanup | no live surviving server / suite / chromium / vite process |

## 12. Flakes

Every lane above passed on its first run at R4. Earlier red runs were the
assertion mistakes in M23_P71_SIGNING_DEFECT_REGISTER.md (T-P71-1 … T-P71-6),
each fixed once. Known P7.1 flakes: 0.
