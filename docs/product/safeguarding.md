# Safeguarding, minors, privacy and authentication

Rules for under-18s and guardians, blocks and reports, privacy of player data, sign-in and sessions.

Founder decisions for this area are in [`../decisions.md`](../decisions.md).

## Founding rules

These are the product's first principles for under-18s. Everything below refines them.

- **Parents own every under-18 account.**
  - Guardian ID verification and a safeguarding disclaimer are hard gates before a child profile can exist. The time the disclaimer was accepted is recorded with it (`disclaimerAcceptedAt`).
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
- Age uses UTC calendar days (18 from the first UTC instant of the birthday; a 29 February birth counts on 1 March). Adulthood follows the jurisdiction's age of majority: a Korean 18-year-old is not an adult, a British one is.
- `isAdult` is true only when the age is known and reaches the threshold. A null, malformed, impossible or future date of birth makes the age `NaN`, never 0, and the person is never treated as an adult.

**Who receives contact, trials and offers (the recipient rule)**
- One function, `resolveContactRecipient`, serves Contact, Trial and Offer. It returns the adult player, or the verified guardian for a minor, or a refusal: `CONTACT_GUARDIAN_REQUIRED`, `CONTACT_RECIPIENT_UNAVAILABLE` or `CONTACT_BLOCKED`. Guardian routing and the trial and contact rules are reused, never duplicated.
- A valid guardian route is a guardian record that exists, lists the child, and has passed the identity and disclaimer checks. If more than one guardian qualifies, the child's primary `guardianId` is chosen (`domains/recruitment/lifecycle/contact.mjs`).
- An offer's recipient is worked out when the offer is issued, and again each time the recipient reads or answers it.

**Offers to minors: the pathway is closed (fail closed)**
- `MINOR_OFFER_PATHWAY_ENABLED` is frozen as false for every jurisdiction and for the default. A club may write a draft on a minor's case. The readiness view shows `MINOR_PATHWAY_CLOSED` and disables Issue. Issuing anyway, including directly through the API, is refused with 422 `OFFER_RECIPIENT_INVALID`.
- A minor's own device lists no offers and cannot answer one (404). A minor cannot share an offer with an agent (403 `OFFER_NOT_PERMITTED`).
- Opening a jurisdiction requires a change to the policy table and a legal review; the routes need no change.
- Dormant until a pathway opens: the issue snapshot names the guardian; only that guardian may answer (not another guardian, the child or an agent); a guardian who lost control or a child who turned 18 gets 422 at answer time; a guardian's block refuses accept but allows decline; notifications go to the guardian, the child sees only the outcome.

**What minors and their guardians can and cannot do**
- Agencies cannot discover minors and there is no route for an agent to represent a minor. The agent's view of a player is adults only.
- Clubs never receive a minor's raw date of birth. An adult's raw date of birth is in no organisation player view either; clubs see age only.
- A minor's profile is labelled "Guardian-managed"; the guardian handles requests, trials and evidence through the normal player-facing routes.
- Club queries check, before any matching: organisation standing, player visibility, blocks, the minor/agency wall, the 50 km radius, then brief eligibility. A hidden or blocked player never enters a candidate set ("matching then concealing is how side channels are born").

**Privacy of events, notifications and logs**
- Every broadcast event is listed in a registry. Each entry has an audience, a privacy class and a list of the payload keys it may carry. An unregistered event defaults to `org_private`, so a new event stays invisible until someone classifies it. Keys not on the list are stripped in production; in development they throw. No list may include a date of birth, email, note, message body, address, password or token.
- A payload that carries an `orgId` is private to that organisation. This check runs before the `playerId` rule, because a leak once sent a club's archive reason to the player's stream.
- Players, guardians and rival clubs never learn about Second Look, Nobody Missed, briefs, coverage or archive reasons. Cross-organisation lookups return the same 404 as a record that does not exist.
- Notification preferences are applied inside `notify()`, so a muted category creates nothing at all. `security_account` is mandatory. Notification types the server does not recognise are still delivered.
- The organisation audit log (leads and directors only) records that a note exists, never its text.
- Logs must never contain a date of birth, guardian email, notes, tokens or documents.
- Trust & Safety has no default access to a club's private recruitment material.

**Authentication**
- No public registration exists for staff or agencies. Self-registration is limited to Grassroots clubs (`/auth/org/register-grassroots`) and Player sign-up.
- Credentials: Pro and Agent use organisation/agency, name, password and role; Trust & Safety an admin key only; the Player app a guardian's email and password (`/auth/guardian/login`) or an 18+ player's id and password (`/auth/player/login`). Player sign-up is adult player, guardian (email code, ID, disclaimer, child) or pairing code.
- Sign-up and login input is valid as sent or refused, naming the field, before any account is looked up or created: a field the form does not have (a sign-up naming its own guardian), an id, name or password that is not text, a height written as text, an app (`platform`) ScoutBox does not have. A malformed date of birth is `DOB_INVALID` whatever its type.
- No fake social sign-in; demo identities only in demo or development builds; no password or token logged; one submission at a time; server refusals shown as real errors, keeping non-sensitive input.
- Only a 401 ends a session. A 403 is the answer to one request and does not end the session.
- Production boot refuses unsafe configuration: the Box Cam test provider, a missing media secret, dev login, or fault injection. Trust Score weights that do not total 100 are fatal in every mode.
- CORS is limited to an allowlist (`SCOUTBOX_ALLOWED_ORIGINS`). Every response carries baseline security headers.

**Entry screens**
- One fixed appearance per entry screen, no theme toggle, saved theme ignored there but kept through sign-out and restored after sign-in. The Player's entry screen shows the promises and the under-18 rules.

**Session exit**
- Every app has a quiet Sign out. Pro, Grassroots and Agent also have Switch organisation / club / profile, which performs the same action. The Player has Switch account.
- Portal sign-out revokes the session (`/auth/logout`), clears the stored session and identity drafts, unmounts the workspace (ending live streams) and signs out other tabs. The old token then gets 401; protected deep links stop at the entry screen.
- Trust & Safety sign-out forgets the key and every record it loaded. There is no server session to revoke.
- Player sign-out revokes the token, clears all state tied to that identity and routes to `/onboarding`. Tokens belonging to other identities are never reused automatically.

## Server contracts

- Blocks, reports, moderation log, org notes, ledger, ops events, source changes and the
  IDV queue are append-ordered and kept.
- Lifting a block deletes it.
- Account deletion leaves every audit row naming the person in place.
- Player references in audit rows are tolerant: unknown or deleted ids are kept and
  counted, never refused. A report naming an unknown player is accepted.
- The report, block, note and ID-check routes take text where they store text: a
  report's target ids and scout name, a block's organisation and reason, an ID check's
  document type. Anything else (a number, an object, a list) gets `400 FIELD_INVALID`
  naming the field; a note that is not text gets `400 TEXT_REQUIRED`. A report reason,
  a resolution outcome or a note longer than 2,000 characters gets `400 FIELD_INVALID`.
  Nothing is stored.
- A block or a report naming an organisation that does not exist gets `404 ORG_NOT_FOUND`.
- An IDV-queue entry must name an existing guardian (strict). An operation that would
  orphan one is refused whole.
- Each of these commits as one unit before the response is sent: a block and its ledger
  row; a moderation hit and its automatic grooming escalation; an urgent report with its
  suspension blocks and frozen requests; a report's resolution with the organisation's
  suspension and the reporter's notice; an IDV submission with the guardian's status.
- The Trust & Safety reports, blocks and moderation lists, the club's ledger and a
  guardian's activity log page by cursor (`{ items, nextCursor }`, 50 a page). Reports
  stay in triage order (urgent pending first, then pending, oldest first; then resolved,
  newest first). The apps read the first page; "load more" is not built.

## Open questions and deferred work

- Offers to minors: closed until a jurisdiction's policy and a legal review exist.
- Trust & Safety access to club recruitment material is not built. A future grant must be scoped to one organisation and record, reasoned, time-bound (not self-extendable), audited on grant, read and expiry (visible to the organisation), and read-only.
- Rate limits are counted per process; there is no shared backend. `SCOUTBOX_RATE_LIMIT_PROVIDER=distributed` is refused loudly.

## Also worth knowing

- Briefs refuse every protected characteristic and proxy (race, ethnicity, religion, sexual orientation, disability, family income, school type, postcode deprivation, physical maturity, national origin), each with its own error code. This is a lasting anti-discrimination rule for the recruitment domain.
