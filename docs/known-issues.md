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
- **`scripts/m181E2E.mjs` fails one check** ("no … key-shaped value appears anywhere"). The heuristic
  `/[A-Za-z0-9_-]{32,}/` matches table, index and migration names in `/capabilities.dataLayer` (for example
  `0017_recruitment_contacts_offers`); it is a false positive, not a leak. Not in CI.
- **`scripts/m182E2E.mjs` fails three checks** (also before 3 Nov): Grassroots screens ask for `desk.*` translation
  keys that don't exist; `orgPanels.tsx` is no longer byte-identical in `scoutbox-club` and `scoutbox-grassroots`
  (which must share business logic); and its backfill fixture leaves one `ROOM_REV_INVALID`. Not in CI.
- **`e2e/m24f2DensityAudit` (3 checks) and `e2e/m24fVisualAudit` (2 checks) fail**, like the M24F audits fixed on
  3 Nov: Player Account categories, the portal ™ label, the Grassroots and Player Home single primary action, and
  the Player Card/ListRow check. Triage them against [`design.md`](design.md).

