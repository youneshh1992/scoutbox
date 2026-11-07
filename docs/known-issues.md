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

## Data model

- **An invitation can bind to a colleague's existing account.** `/auth/org/accept-invite` binds the invite to
  whichever account of the organisation has the invited name, sets that account's e-mail to the invite's and returns
  a session without the account's MFA. So a lead who invites "Maria Keane" to their own address signs in as Maria.
  Found in the S14f review (it predates S14f, which only extends it to removed accounts, whose restore the Founder
  approved). The fix is probably that an invite under a current colleague's name is refused, or needs that person's
  confirmation: a product question.
- **Staff quiet hours are saved but never applied.** `PUT /org/delivery/prefs` stores a staff member's quiet hours,
  but the delivery centre only honours the e-mail on/off switch for staff (players' and guardians' quiet hours do
  work). Found in S14f; making it work is a feature, so it waits for the end of the freeze.
- **A grassroots club approved through a Trust & Safety application is placed in central London.** The claim review
  (`domains/verification/claims/review.mjs`) creates the club at 51.5, -0.1 with the federation registration
  "pending", because the application has no ground location. Its 50 km scouting radius, its place on players' "clubs
  near you" radar and the friendlies board are then measured from a ground that isn't real, and the club can't
  correct it. Clubs that register directly give their real ground. The fix (asking for the ground on the application,
  which needs a place-to-coordinates lookup) is a feature, so it waits for the end of the freeze (Founder, 7 Nov).
- **The sign-in screens list every organisation.** `GET /orgs` returns the whole list (one indexed query since S14g)
  for the club picker; it isn't paged because the apps have no search, so clubs past the first page couldn't find
  themselves. It needs a name search before there are many clubs: a feature, after the freeze (Founder, 7 Nov).

- **Assessment templates are shared by every club.** When one club's lead publishes a new version of a position
  template (`POST /org/assessment-templates`), it becomes the current template for every club: other clubs' new
  assessments use it, though reports already written keep their version. Deferred until the migration is finished
  (decisions.md, 4 Nov). The fix: each club gets its own templates (an `org_id` on `assessment_templates`), starting
  from the four standard v1 templates.
- **Evidence records copy people's names as text and cut them at 200 characters.** The evidence passport, disputes,
  evidence history, coach affiliations and squad invitations store a copy of the player's, scout's or club's name
  (an org dispute stores "scout · club"). Player signup has no name length limit, and a scout name plus a club
  name can reach 243 characters, so `domains/scouting/passport.mjs` (`storedName`) shortens names to fit rather
  than failing the action. The robust fix is to store only the person's or organisation's id, referencing the
  players, staff and orgs tables, and read the current name from there. That also stops the copies going stale
  when someone renames themselves.

## Tests

- **`testBackup` failed once in about 40 parallel `npm test` runs** (3 Nov), and the log wasn't kept. It didn't
  reproduce in 18 further runs under heavy load. Its strictest check compares the backup with the source table for
  table, so anything the server writes after the copy (other than the `backup_created` event) fails it. If it fails
  again, the runner prints the whole log: note which table differed.
- **`testWriterAtomicity` failed once in five full `npm test` runs** (4 Nov), and the log wasn't kept. It passed
  alone three times and in the next two full runs. If it fails again, keep the runner's log.
- **`testRecruitmentContactsOffersServer` failed once in three full `npm test` runs** (4 Nov, S9b): "reading seen
  offers commits nothing" (`data_version` 3, expected 2). It passed alone four times and in the next two full runs.
  The check asserts that nothing commits in a 3-second window, so a late save of the earlier offer writes under load
  is the likely cause. If it fails again, note what committed in the window.
- **`e2e/platform/contracts.mjs` fails one check**: `orgPanels.tsx` is no longer byte-identical in `scoutbox-club` and
  `scoutbox-grassroots` (which must share business logic). Grassroots shows audit entries as structured facts since
  `7f93a14` (1 Nov); Club still shows one sentence. Deciding which one both apps use is a design question. A `knownFailure` check ("orgPanels.tsx drift"), so the
  battery runs in CI.
- **`e2e/m24f2DensityAudit` (3 checks) and `e2e/m24fVisualAudit` (2 checks) fail**, like the M24F audits fixed on
  3 Nov: Player Account categories, the portal ™ label, the Grassroots and Player Home single primary action, and
  the Player Card/ListRow check. Triage them against [`design.md`](design.md).

