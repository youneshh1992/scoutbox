# Known issues

Known defects that are not fixed yet. Remove an entry when it's fixed. The list from the November 2026 cleanup was
fixed on 3 November; these were found while fixing it.

## Configuration

- **A production server without SendGrid hands out the guardian e-mail code.** With no `SENDGRID_API_KEY` the mail
  adapter is the dev outbox, and `/auth/guardian/signup` then returns `devEmailCode` in its response, even under
  `NODE_ENV=production`. E-mail verification, the first safeguarding gate, is skipped in effect.
- **Production ID verification always approves.** There is no real IDV provider, so the dev attestation runs in
  every mode and any document reference passes. `/capabilities` now says so (`authoritative_identity_provider:
  not_configured`), but nothing stops a production guardian from completing the ID gate.

## Tests

- **`testBackup` failed once in about 40 parallel `npm test` runs** (3 Nov), and the log wasn't kept. It didn't
  reproduce in 18 further runs under heavy load. Its strictest check compares the backup with the source table for
  table, so anything the server writes after the copy (other than the `backup_created` event) fails it. If it fails
  again, the runner prints the whole log: note which table differed.
- **`testWriterAtomicity` failed once in five full `npm test` runs** (4 Nov), and the log wasn't kept. It passed
  alone three times and in the next two full runs. If it fails again, keep the runner's log.
- **`e2e/platform/contracts.mjs` fails one check**: `orgPanels.tsx` is no longer byte-identical in `scoutbox-club` and
  `scoutbox-grassroots` (which must share business logic). Grassroots shows audit entries as structured facts since
  `7f93a14` (1 Nov); Club still shows one sentence. Deciding which one both apps use is a design question. Not in CI.
- **`e2e/agents/corePersistence.mjs` fails one check** ("the migrated staff member is an assistant"). It boots over a
  schema-2304 blob snapshot, but `server.mjs` runs the `m182` steps before `attachDataLayer`, and staff accounts are
  table-backed since S0, so `m240_001_agent_core_stores` sees no `db.users` and gives the staff member no
  affiliation. Only an old development-build file reaches this. It goes when S11 moves the affiliations into tables
  and the step becomes a no-op. Not in CI.
- **`e2e/m24f2DensityAudit` (3 checks) and `e2e/m24fVisualAudit` (2 checks) fail**, like the M24F audits fixed on
  3 Nov: Player Account categories, the portal ™ label, the Grassroots and Player Home single primary action, and
  the Player Card/ListRow check. Triage them against [`design.md`](design.md).

