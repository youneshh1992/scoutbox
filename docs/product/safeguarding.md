# Safeguarding, minors, privacy and authentication

Rules for under-18s and guardians, blocks and reports, privacy of player data, sign-in and sessions.

> Names in brackets, like (M17_RECRUITMENT_ROOMS), are the original milestone documents. They were removed in the November 2026 cleanup; read one with `git show docs-archive-2026-11:M17_RECRUITMENT_ROOMS.md`. Founder decisions and resolved contradictions for this area are in [`../decisions.md`](../decisions.md).

## Founding rules (the original product deck, Milestone 3)

These are the product's first principles for under-18s. Everything below refines them. (Old README.md, "Deck rules enforced in code")

- **Parents own every under-18 account.**
  - Guardian ID verification and a safeguarding disclaimer are hard gates before a child profile can exist.
  - A minor can't sign themselves up (`403 GUARDIAN_REQUIRED`).
- **No child receives direct messages, ever.**
  - It is scout → parent, not scout → child. Contact and trial requests to a minor go to the guardian.
  - The child sees only sanitised status updates. A guardian's acceptance opens an adult-to-adult channel.
- **Clubs.**
  - Parents see the verified club and the sender's verified role, not a bare name.
  - Only verified clubs ever see minors (`403 VERIFIED_CLUBS_ONLY`). Verification means a company e-mail domain plus a signed safeguarding contract.
  - Agencies can never list, view or contact a minor.
- **No social features.** No comments, likes, followers or public messaging. Minor profiles are app-only: the city and exact birth date are stripped from every org view.
- **Moderation and reporting.**
  - Personal contact details, social handles and attempts to move off-platform are blocked in messages, media titles and timeline events (`400 MODERATION_BLOCKED`).
  - Report and Block are on every screen of every app. An urgent report suspends communication pending review.
- **Accountability.** All communications are logged, and parents can read the full ledger for their children. Every discovery action is attributed to a named scout and org; a request without an individual user id is refused.
- **Children keep the football.** Uploads, stats edits and drills stay under the child's control.

## How it works

**Age and minority**
- Age uses UTC calendar days (18 from the first UTC instant of the birthday; a 29 February birth counts on 1 March). Adulthood follows the jurisdiction's age of majority: a Korean 18-year-old is not an adult, a British one is. (M18_2_FINAL_CLEANUP)
- `isAdult` is true only when the age is known and reaches the threshold. A null, malformed, impossible or future date of birth makes the age `NaN`, never 0, and the person is never treated as an adult. (M23_P6_MINOR_GUARDIAN_MODEL, M18_2_FINAL_CLEANUP)

**Who receives contact, trials and offers (the recipient rule)**
- One function, `resolveContactRecipient`, serves Contact, Trial and Offer. It returns the adult player, or the verified guardian for a minor, or a refusal: `CONTACT_GUARDIAN_REQUIRED`, `CONTACT_RECIPIENT_UNAVAILABLE` or `CONTACT_BLOCKED`. Guardian routing and the trial and contact rules are reused, never duplicated. (M23_P6)
- A valid guardian route is a guardian record that exists, lists the child, and has passed the identity and disclaimer checks. If more than one guardian qualifies, the child's primary `guardianId` is chosen. (code, m23/contact.mjs)
- An offer's recipient is worked out when the offer is issued, and again each time the recipient reads or answers it. (M23_P6)

**Offers to minors: the pathway is closed (fail closed)**
- `MINOR_OFFER_PATHWAY_ENABLED` is frozen as false for every jurisdiction and for the default. A club may write a draft on a minor's case. The readiness view shows `MINOR_PATHWAY_CLOSED` and disables Issue. Issuing anyway, including directly through the API, is refused with 422 `OFFER_RECIPIENT_INVALID`. (M23_P6)
- A minor's own device lists no offers and cannot answer one (404). A minor cannot share an offer with an agent (403 `OFFER_NOT_PERMITTED`). (M23_P6)
- Opening a jurisdiction requires a change to the policy table and a legal review; the routes need no change. (M23_P6)
- Dormant until a pathway opens: the issue snapshot names the guardian; only that guardian may answer (not another guardian, the child or an agent); a guardian who lost control or a child who turned 18 gets 422 at answer time; a guardian's block refuses accept but allows decline; notifications go to the guardian, the child sees only the outcome. (M23_P6)

**What minors and their guardians can and cannot do**
- Agencies cannot discover minors and there is no route for an agent to represent a minor. The agent's view of a player is adults only. (M23_P6)
- Clubs never receive a minor's raw date of birth. Since M18.1 an adult's raw date of birth has also been removed from every organisation player view; clubs see age only. (M18_1_HARDENING)
- A minor's profile is labelled "Guardian-managed"; the guardian handles requests, trials and evidence through the normal player-facing routes. (M18_SECOND_LOOK §17)
- Club queries check, before any matching: organisation standing, player visibility, blocks, the minor/agency wall, the 50 km radius, then brief eligibility. A hidden or blocked player never enters a candidate set ("matching then concealing is how side channels are born"). (M18_SECOND_LOOK, M18_MATRIX)

**Privacy of events, notifications and logs**
- Every broadcast event is listed in a registry. Each entry has an audience, a privacy class and a list of the payload keys it may carry. An unregistered event defaults to `org_private`, so a new event stays invisible until someone classifies it. Keys not on the list are stripped in production; in development they throw. No list may include a date of birth, email, note, message body, address, password or token. (M18_1_HARDENING, M18_2)
- A payload that carries an `orgId` is private to that organisation. This check runs before the `playerId` rule, after an M17 leak sent a club's archive reason to the player's stream. (M18_SECOND_LOOK §16)
- Players, guardians and rival clubs never learn about Second Look, Nobody Missed, briefs, coverage or archive reasons. Cross-organisation lookups return the same 404 as a record that does not exist. (M18_SECOND_LOOK)
- Notification preferences are applied inside `notify()`, so a muted category creates nothing at all. `security_account` is mandatory. Notification types the server does not recognise are still delivered. (M18_2)
- The organisation audit log (leads and directors only) records that a note exists, never its text. (M18_2)
- Logs must never contain a date of birth, guardian email, notes, tokens or documents. (M18_2_MATRIX)
- Trust & Safety has no default access to a club's private recruitment material. (M18_1)

**Authentication**
- No public registration exists for staff or agencies. Self-registration is limited to Grassroots clubs (`/auth/org/register-grassroots`) and Player sign-up.
- Credentials: Pro and Agent use organisation/agency, name, password and role; Trust & Safety an admin key only; the Player app a guardian's email and password (`/auth/guardian/login`) or an 18+ player's id and password (`/auth/player/login`). Player sign-up is adult player, guardian (email code, ID, disclaimer, child) or pairing code.
- No fake social sign-in; demo identities only in demo or development builds; no password or token logged; one submission at a time; server refusals shown as real errors, keeping non-sensitive input. (M24C, M24D)
- Only a 401 ends a session. A 403 is the answer to one request and does not end the session. (M18_2)
- Production boot refuses unsafe configuration: the Box Cam test provider, a missing media secret, dev login, or fault injection. Trust Score weights that do not total 100 are fatal in every mode. (M18_1, M18_2)
- CORS is limited to an allowlist (`SCOUTBOX_ALLOWED_ORIGINS`). Every response carries baseline security headers. (M18_1)

**Entry screens**
- One fixed appearance per entry screen, no theme toggle, saved theme ignored there but kept through sign-out and restored after sign-in. The Player's entry screen shows the promises and the under-18 rules. (M24E_AUTH_SINGLE_MODE, M24C)

**Session exit**
- Every app has a quiet Sign out. Pro, Grassroots and Agent also have Switch organisation / club / profile, which performs the same action. The Player has Switch account.
- Portal sign-out revokes the session (`/auth/logout`), clears the stored session and identity drafts, unmounts the workspace (ending live streams) and signs out other tabs. The old token then gets 401; protected deep links stop at the entry screen.
- Trust & Safety sign-out forgets the key and every record it loaded. There is no server session to revoke.
- Player sign-out revokes the token, clears all state tied to that identity and routes to `/onboarding`. Tokens belonging to other identities are never reused automatically. (M24E_SESSION_EXIT)

## Server contracts (from the old operations runbook)

- Blocks, reports, moderation log, org notes, ledger, ops events, source changes and the
  IDV queue are append-ordered and kept.
- Lifting a block deletes it.
- Account deletion leaves every audit row naming the person in place.
- Player references in audit rows are tolerant: unknown or deleted ids are kept and
  counted, never refused. A report naming an unknown player is accepted.
- An IDV-queue entry must name an existing guardian (strict). An operation that would
  orphan one is refused whole.
- A block and its ledger row land together. An IDV submission commits together with the
  guardian's status before the response is sent.

## Open questions and deferred work

- Offers to minors: closed until a jurisdiction's policy and a legal review exist.
- Trust & Safety access to club recruitment material is not built. A future grant must be scoped to one organisation and record, reasoned, time-bound (not self-extendable), audited on grant, read and expiry (visible to the organisation), and read-only. (M18_1)
- Rate limits are counted per process; there is no shared backend. `SCOUTBOX_RATE_LIMIT_PROVIDER=distributed` is refused loudly. (M18_1)
- Push quiet hours and the minors' school-hours mute use server-local time, not UTC, and there is no push transport yet. (M18_2)
- Email is recorded as an intent in a local outbox only; nothing is sent. (M18_2)

## Also worth knowing

- M18_SECOND_LOOK_NOBODY_MISSED §11: briefs refuse every protected characteristic and proxy (race, ethnicity, religion, sexual orientation, disability, family income, school type, postcode deprivation, physical maturity, national origin), each with its own error code. A lasting anti-discrimination rule for the recruitment domain.

## Where the code enforces it

*Spot-checked against the code on 3 November 2026. ✓ enforced, ✗ not found, ≠ differs from the old docs.*

- ✓ The minor offer pathway is closed for every jurisdiction: `scoutbox-server/m28/offer.mjs:116`. Issue is refused at `m28/index.mjs:449`, and readiness shows the blocker at `m28/index.mjs:205`.
- ✓ The recipient rule returns the guardian route or `CONTACT_GUARDIAN_REQUIRED`, and the block refusal is checked first: `m23/contact.mjs:250`.
- ✓ An unknown age is never adult (`domain.mjs:76`), and age uses UTC getters with `NaN` for a bad date (`temporal.mjs:339`).
- ✓ Unregistered events default to `org_private`: `m182/eventRegistry.mjs:559`.
- ✓ `security_account` is mandatory: `m182/notificationPrefs.mjs:78`.
- ✓ `/auth/logout` revokes the session id on the server: `server.mjs:764`.
- ✓ Production boot refuses the Box Cam test provider and a missing media secret: `m181/capabilities.mjs:137`, `:144`.
- ✓ Development logins exist only outside production, by one rule (`devLoginsEnabled`, `m181/capabilities.mjs`). A production boot with `ALLOW_DEV_LOGINS` set is refused (`DEV_LOGIN_IN_PRODUCTION`).
