# ScoutBox — Full System (Milestone 9: the Grassroots player journey)

Five pieces, one live dataset:

| Folder | What it is | Run |
|---|---|---|
| `scoutbox-server/` | The sync backend all apps share. Enforces the deck's rules server-side. SQLite persistence (`data/scoutbox.db`), bearer-token sessions, adapter seams for mail/push/IDV/billing/storage. | `npm install && npm start` (port 4000) |
| `scoutbox-player/` | The player mobile app (Expo/React Native). | `npm install && npx expo start --web` |
| `scoutbox-club/`   | The club & agent desktop application (React, landscape). | `npm install && npm run dev` (port 5173) |
| `scoutbox-admin/`  | The internal Trust & Safety console (reports, verification, IDV, suspensions, audit). | `npm install && npm run dev` (port 5174, key: `scoutbox-admin`) |
| `scoutbox-grassroots/` | **ScoutBox Grassroots** — the separate club platform for federation-registered semi-pro & amateur clubs. | `npm install && npm run dev` (port 5175) |

## Live sync
Start the server first. The club app connects to it automatically (localhost:4000).
To connect the player app to the same live data, start it with:
`EXPO_PUBLIC_API_URL=http://localhost:4000 npx expo start --web`
(without the variable it runs in self-contained demo mode).
Then: a club's contact/trial request appears in the player's Inbox instantly; a
player's Academy+ toggle or upload appears in club search instantly.

Messaging is symmetric and observable: messages flow both ways with read receipts
(✓✓) and typing indicators; new messages pop a notification and put a red unread
count next to Messages (club sidebar) and on the Inbox tab (player app). The static
demo builds sync across same-browser tabs too (BroadcastChannel bus), so the club
tab and player tab hold one real conversation.

## Milestone 9: the Grassroots player journey
Features exclusive to amateur and semi-pro players — the academy experience,
without the academy. Pro-level players never see any of it; every safeguarding
rule holds unchanged.

- **The pathway** — the amateur → semi-pro → academy/pro ladder, visible on the
  player's Home with the signals clubs actually check (verified attendance,
  verified clips, combine results, coach references). Levels move on real
  signings; the **level-up moment** is celebrated: notification, timeline
  entry, First Club badge, guardian informed.
- **Grassroots badges** — Turnstile, Ever-Present, Season Regular, Iron Streak,
  Combine Proven, First Club. Earned automatically from the record, never
  purchasable.
- **Free training programmes** — position-specific weekly tracks built from the
  verified combine drills; completed sessions feed streaks and the weekly goal.
- **Cohort benchmarks** — percentiles vs amateur/semi-pro players in the same
  position group ("top 9% for goals"). Context, never a leaderboard, and never
  measured against pros.
- **The opportunity radar** — the 50km rule pointed the player's way: local
  grassroots clubs with distance, what positions they're looking for, and
  their open days.
- **Open trial days** — grassroots clubs post open sessions; local adults
  register in-app, guardians register their children (only to clubs allowed to
  see them — verified + local, enforced server-side).
- **First Team Seekers** — players (or guardians, for children) flag "looking
  for my first club" and surface first to local grassroots clubs. Need-based,
  free, never purchasable — Grassroots' own answer to Academy+.
- **Coach references** — a named coach confirms by emailed one-time code; the
  reference is moderated like every message and shows on the profile for every
  club (coach email never exposed; admin can revoke).
- **Season wrap** — the verified year in one card: goals, streak record,
  combine bests, badges, scout views.

## Milestone 8: ScoutBox Grassroots — a separate platform for the local game
The club side is now two platforms with a hard, server-enforced wall between
them. **ScoutBox** serves academies and above; **ScoutBox Grassroots** serves
federation-registered semi-pro and amateur clubs only. The player app is
unchanged — one player pool, two windows onto it.

- **Platform separation at login**: a grassroots club can only log into
  Grassroots (`GRASSROOTS_PLATFORM_ONLY`), every other org only into ScoutBox
  (`PLATFORM_MISMATCH`); each login screen lists only its own platform's clubs.
- **The 50km rule**: grassroots clubs see only players within 50km of their
  registered ground (haversine, server-side, in the same `visibleToOrg` choke
  point as the under-18 wall; missing coordinates fail closed). Search ranks
  nearest first and every card shows the distance. Coordinates never leave the
  server — only the computed distance does.
- **The level ceiling**: players are `amateur`, `semi_pro` or `pro`. Pro-level
  players never appear on Grassroots. A grassroots signing makes a player
  semi-pro (still local); an academy/pro signing makes them pro — and they
  leave the Grassroots pool automatically.
- **No pro-market surface**: Academy+ cohort, market value and agent details
  don't exist on Grassroots — stripped by the server, not hidden by the UI.
- **Federation registration**: grassroots clubs register with their
  federation's registration id and their ground location; they start
  unverified (adults only) until Trust & Safety clears them — under-18
  visibility takes exactly the same verification + safeguarding contract as
  any club on any platform.
- Deployed alongside the rest: the single container serves it at
  `/grassroots` (club app at `/app`, console at `/console`).

## Milestone 7 additions (production hardening)
- **Real authentication** — signups require a password (scrypt-hashed, never stored
  or echoed in plain text); every login mints a bearer session token and the API
  trusts nothing else (the old trusted-id headers are refused). Rate limiting
  blunts credential stuffing on all `/auth` routes. Pre-M7 seed identities stay
  passwordless for the demo logins.
- **Guardian email verification** — a mailed code is the first of three gates
  (email → ID → disclaimer) before any child profile can exist.
- **SQLite persistence** — atomic transactional snapshots in `data/scoutbox.db`
  (node:sqlite, zero native deps); a legacy `db.json` is imported once. Media
  files live on object storage (local disk in dev), outside the database.
- **Adapter seams with working dev transports** — email (`SENDGRID_API_KEY`),
  push (`EXPO_ACCESS_TOKEN`), IDV (`ONFIDO_API_TOKEN`), billing
  (`STRIPE_SECRET_KEY`), object storage (`S3_BUCKET`). Until a key is set, mail
  lands in the admin outbox, pushes in the push log, invoices on the dev ledger —
  everything works and is auditable. See `DEPLOY.md`.
- **Recruitment funnel** — the club's pipeline (views → saves → shortlists →
  requests → accepted → trials → reports → signings) computed from the ledger.
- **Success-fee billing** — a signing inside the attribution window issues an
  invoice automatically; clubs see them under Plan, staff under Billing.
- **Club email-domain verification** — clubs prove control of a company mailbox
  (free-mail refused) via a mailed challenge code.
- **Moderation v2** — obfuscated contact details ("name (at) domain (dot) com"),
  more platforms, and grooming-pattern language which not only blocks but
  auto-escalates as an urgent report to the T&S queue (triage: urgent first).
- **CI + deployment** — GitHub Actions runs unit tests, the 51-check API
  end-to-end and all app builds on every push; a single-container `Dockerfile`
  serves the API + club app (`/app`) + T&S console (`/console`), with `fly.toml`
  and `render.yaml` ready to go.

## Milestone 6 additions
- Trial invitations carry proposed date + alternate slots + venue; the accepting
  side picks the slot, and every booked trial exports as an `.ics` calendar file.
- Mandatory trial reports now include written feedback (strength / work-on) that
  lands on the player profile.
- Saved searches alert clubs when a matching player joins. Signings are recorded
  against the attribution window (`db.signings`).
- Players build a season-by-season history; profiles show past seasons.
- Guardians pair a child's device with a single-use 6-character code (15-minute
  expiry). At 18, a guardian-linked account hands over to the player (aging-up).
- Notification preferences: quiet hours for everyone, school-hours mute default-on
  for minors (pushes defer; the in-app feed always keeps the record).
- Data rights: full JSON export and account deletion for players and guardians
  (minors delete via the guardian; the append-only ledger keeps ids only).
- Player-facing club directory: verified + safeguarding-certified badges, trials
  run, reports filed and average days-to-file. Clubs only — agencies never listed.
- Internal Trust & Safety console (`scoutbox-admin/`): report queue with outcomes
  (reporter is notified), club verification, guardian IDV, suspensions, moderation
  log, thread audit.

## Deck rules enforced in code (server-side, not just UI)
- Under-18 players with parental safeguarding (Milestone 3):
  - Parents own every under-18 account. Guardian ID verification + safeguarding
    disclaimer are hard gates before a child profile can exist; minor self-signup
    is rejected by the API (`403 GUARDIAN_REQUIRED`).
  - No child can receive direct messages — ever. Scout → Parent, not Scout → Child:
    all contact/trial requests to minors route to the guardian; the child sees only
    sanitized status updates (no message, no channel).
  - Trial invitations instead of open chat: the parent receives "X FC has requested
    to discuss a trial" and accepts/declines. Acceptance opens an adult-to-adult channel.
  - Club-first communication: parents see the verified club + the sender's verified
    role (e.g. Head of Recruitment), not a bare name.
  - Verified clubs only: unverified clubs never see minors (`403 VERIFIED_CLUBS_ONLY`);
    verification = company email domain + signed safeguarding contract.
  - No comments, no likes, no followers, no public messaging. Minor profiles are
    app-only: city and exact DOB stripped from every org view.
  - AI moderation (prototype): personal contact details, social handles and
    off-platform contact blocked in messages, media titles and timeline events
    (`400 MODERATION_BLOCKED`); children cannot share contact details through the platform.
  - One-click Report User / Report Scout / Report Club + Block on every screen of both
    apps; urgent reports immediately suspend communication pending review.
  - All communications logged — parents can read the full ledger for their children.
  - Children keep the football: uploads, stats edits and drills stay child-controlled.
- The under-18 wall: agency accounts can never list, view or contact a minor — no
  agent access to under-18 profiles under any circumstances.
- Scout Inbox: no direct contact channel exists; requests unlock only on player acceptance.
- Discovery Ledger: every view/save/shortlist/contact/trial/signing timestamped to a named scout + org.
- Accountability by user: requests without an individual user id are refused.
- Proof Pack: attribution evidence (first qualifying interaction, window, event log) on demand.
- Academy+: opt-in only, player-controlled badges, surfaced as a priority cohort, framed as a fresh start.
- Fee protection: attribution windows and anti-circumvention terms surfaced in Plan & compliance.
- Trial Performance Reports: MANDATORY after every trial — acceleration, sprint speed, distance,
  pass completion, duel success, coach rating. Partial reports rejected; filed reports sync to the
  player profile and raise the Trust Score (institutional corroboration).
- Medical Reports: player-controlled per data-protection law — invisible to every org unless the
  player switches sharing on. Injury history, layoffs, surgeries, clearances, condition status.
- Availability + Contract Status: player-displayed (available now, end of season, loans, overseas,
  not seeking; contract expiring / scholarship ending / release approaching).
- Verified Match Attendance: fixture + venue + date confirmed by GPS + device data; trust rises
  because ScoutBox knows the player physically participated.
- Transfer Timeline: career milestones on every profile.
- Scout & Coach Reputation: discoveries, success rate, avg resale multiple — seeded track records
  plus live rows computed from the Discovery Ledger.
- AI Similar Players Engine: statistical similarity to reference playing profiles (position, foot,
  age, output, physique) — a lead, not a verdict.

Demo logins for the club app: Eastport FC (club, Pro, Trusted Partner),
Harbour City FC (club, Academy), North Star Sports Agency (agency — see the wall).
