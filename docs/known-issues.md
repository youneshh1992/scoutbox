# Known issues

Defects and stale spots found while distilling the old documents (November 2026 cleanup) that are not yet fixed.
Remove an entry when it's fixed. None of them matters until there is a real deployment, but each is a real bug.

## Tests

- **Three server batteries fail and are kept out of CI:** `m23Persistence`, `m23BootContract` and
  `m23AgentTransactionPersistence`. The boot contract predates the SQLite migration.

## Product

- **A second request writer:** the Grassroots open-day `invite_trial` bypasses `issueRecruitmentRequest`.
- **The guardian sign-up e-mail code is stored in plain text**, unlike every other one-time code.
