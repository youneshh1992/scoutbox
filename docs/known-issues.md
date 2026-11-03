# Known issues

Defects and stale spots found while distilling the old documents (November 2026 cleanup) that are not yet fixed.
Remove an entry when it's fixed. None of them matters until there is a real deployment, but each is a real bug.

## Configuration and boot

- **The deploy configs wouldn't boot.** `fly.toml` and `render.yaml` set only `ADMIN_KEY`, but a production boot also
  needs the media secret and an admin key of at least 16 characters. Neither target is live.
- **The Docker image can't build the web portals.** Each portal's build stage copies only its own folder
  (`COPY scoutbox-club/ ./`), but the portals import from outside it: `../../design-system` and, for Pro and
  Grassroots, `../../scoutbox-server/roles.mjs`. Build from the repository root (copy `design-system/` and
  `scoutbox-server/roles.mjs` into each stage) before relying on the image.
- **There's no empty production start.** A first boot always loads the demo seed; production mode only refuses
  the passwordless demo logins. (The migration plan's S13 makes demo data opt-in.)

## Tests

- **Three server batteries fail and are kept out of CI:** `m23Persistence`, `m23BootContract` and
  `m23AgentTransactionPersistence`. The boot contract predates the SQLite migration.
- **The `e2e/m24f3DensityAudit`, `m24f4MinimalismAudit` and `m24f5VisualAcceptanceAudit` source checks fail**
  (5, 4 and 8 checks). They encode M24F minimalism rules that the later approved designs partly overrode (Player
  system font, Pro/Grassroots restyles), plus a few real regressions such as emoji in `scoutbox-club/src/m18Screens.tsx`.
  Triage them: delete the checks the approvals overrode and fix the rest. See [`design.md`](design.md).

## Product

- **A second request writer:** the Grassroots open-day `invite_trial` bypasses `issueRecruitmentRequest`.
- **M22 routes don't call `refusedClientFields()`.**
- **Fix before S11:** the migration plan records a defect in how `m25/index.mjs` reads
  `req.org.settings.jurisdictions` (around lines 254 and 370). Not re-verified in the cleanup.
- **The guardian sign-up e-mail code is stored in plain text**, unlike every other one-time code.
