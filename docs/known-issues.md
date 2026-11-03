# Known issues

Defects and stale spots found while distilling the old documents (November 2026 cleanup) that are not yet fixed.
Remove an entry when it's fixed. None of them matters until there is a real deployment, but each is a real bug.

## Configuration and boot

- **The dev-login production gate checks the wrong variable.** `m181/capabilities.mjs` refuses a production boot when
  `SCOUTBOX_ALLOW_DEV_LOGIN` is set, but the server reads `ALLOW_DEV_LOGINS` (`server.mjs` around line 777), and in
  production that only prints a warning. Pick one name and make the gate check it.
- **The media-signing secret has two names.** The production gate and `/capabilities` check `SCOUTBOX_MEDIA_SECRET`
  (`m181/capabilities.mjs` around line 144). Media URLs are signed with `MEDIA_SECRET`, falling back to a generated
  secret stored in the database (`db.secrets.mediaSign`, `server.mjs` around line 432). So setting the gated variable
  changes nothing. The README and tests use one name; `scoutbox-server/.env.example` uses the other.
  Backups may contain the stored secret.
- **`/capabilities` reports adapters from names the adapters don't read:** `SCOUTBOX_SMTP_URL`/`SMTP_URL`,
  `SCOUTBOX_IDV_PROVIDER` and `SCOUTBOX_STORAGE_BUCKET`, whereas the adapters read `SENDGRID_API_KEY`,
  `ONFIDO_API_TOKEN` and `S3_BUCKET`.
- **The "live" ID-verification, Stripe and S3 adapters are stubs.** IDV auto-approves and S3 writes to local disk.
  Only SendGrid and Expo push make real calls.
- **The deploy configs wouldn't boot.** `fly.toml` and `render.yaml` set only `ADMIN_KEY`, but a production boot also
  needs the media secret and an admin key of at least 16 characters. Neither target is live.
- **There's no empty production start.** A first boot always loads the demo seed; production mode only refuses
  the passwordless demo logins. (The migration plan's S13 makes demo data opt-in.)
- **`scripts/setup.mjs` is stale.** It says Node ≥22.5 with a JSON fallback. The real requirement
  (`scoutbox-server/runtime.mjs`, `engines`) is ≥22.16 on the 22 line or ≥24, with no fallback.

## Tests

- **Three server batteries fail and are kept out of CI:** `m23Persistence`, `m23BootContract` and
  `m23AgentTransactionPersistence`. The boot contract predates the SQLite migration.
- **The `e2e/m24f3DensityAudit`, `m24f4MinimalismAudit` and `m24f5VisualAcceptanceAudit` source checks fail**
  (5, 4 and 8 checks). They encode M24F minimalism rules that the later approved designs partly overrode (Player
  system font, Pro/Grassroots restyles), plus a few real regressions such as emoji in `scoutbox-club/src/m18Screens.tsx`.
  Triage them: delete the checks the approvals overrode and fix the rest. See [`design.md`](design.md).

## Product

- **Finance visibility is inconsistent.** The server's `canViewFinance` (`m13/shared.mjs:194`) admits `finance` and
  `treasurer` roles; the navigation and docs say lead roles only. Decide which is intended. (See
  [`decisions.md`](decisions.md) §6.)
- **A second request writer:** the Grassroots open-day `invite_trial` bypasses `issueRecruitmentRequest`.
- **M22 routes don't call `refusedClientFields()`.**
- **Fix before S11:** the migration plan records a defect in how `m25/index.mjs` reads
  `req.org.settings.jurisdictions` (around lines 254 and 370). Not re-verified in the cleanup.
- **The guardian sign-up e-mail code is stored in plain text**, unlike every other one-time code.
