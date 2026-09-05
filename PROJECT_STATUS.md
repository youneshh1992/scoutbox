# ScoutBox — Project Status & Handoff

> Purpose of this file: let any Claude Code session (cloud or local) pick up this
> project with zero prior context. Keep it updated at the end of each working session.

**Last updated:** 2026-09-05 · **Milestone: 11 complete — one connected
system: connected mode is the real application (explicit demo flags, live
default), authenticated + scoped SSE with reconnect replay, HMAC-signed media
URLs, crash-durable messages/requests/read-state, idempotent sends with
pending/failed/retry UI, channel eligibility rechecks (blocks/suspensions/
platform changes close threads), production gate on seeded dev logins + org
credentials, ScoutBox Pro branding, root launcher (`scripts/dev-all.mjs`),
.env examples, 32-check connectedE2E + 4-scenario separate-context live
browser suite**; previously: **10 complete — the grassroots club
toolkit (squad + gap analysis, coach-signed match-day attendance, open-day
outcomes + the no-ghosting rule, release-with-reference, Pathway Club record,
friendlies board, federation-route verification, mobile pass) + player
onboarding visual redesign**; previously: **9 — the Grassroots player journey
(pathway + level-up moments, badges, training programmes, cohort benchmarks,
opportunity radar, open trial days, First Team Seekers, coach vouches, season
wrap)**; **8 — ScoutBox Grassroots, a separate club platform (org levels, 50km
radius, platform-scoped logins, federation registration, level ceiling)**;
**7 — production hardening (real auth + sessions, SQLite, adapter seams,
funnel analytics, moderation v2, CI + Docker deploy)** ·
Developed in this GitHub repo (`youneshh1992/scoutbox`), Claude Code web.

## Milestone 11 (2026-09-05): one connected system

Connected mode is the product; demo is an explicit, labelled aside.

Server (`scoutbox-server/server.mjs`):
- **SSE**: `POST /events/ticket` (bearer) mints a 10-min connect ticket;
  `GET /events?ticket=` resolves identity from the live session at connect
  time. Every event carries an `id:`; a 500-event ring buffer replays missed
  events on reconnect (`lastEventId` query / Last-Event-ID header), ending
  with `caught_up`. `shouldDeliver()` scopes: channel events only to channel
  members (a minor's channel never reaches the child — counterparty is the
  guardian), playerId events only to the player/their guardian/orgs that pass
  `visibleToOrg` + block checks, notify events only to their audience.
  Suspended orgs cannot mint tickets. Typing is never buffered.
- **Media**: every `/media/...` path is HMAC-signed (6 h expiry) at response
  serialisation via one `res.json` choke point (copy-on-write deep walk).
  `/media/:id` accepts a valid signature OR a bearer session entitled to the
  owning player; everything else is 401. Secret persisted in `db.secrets`
  (`MEDIA_SECRET` env override).
- **Durability**: `persistNow()` on message post, read-state, request
  create/respond — SIGKILL loses nothing (proved in connectedE2E §7).
  `DATA_DIR` env isolates test databases.
- **Idempotency**: `clientMsgId` deduped per sender in `postMessage` across
  all three send endpoints.
- **Channel rechecks**: `channelClosedForOrg` / `channelClosedForCounterparty`
  run on every send/typing — blocks, suspensions and platform/level/radius
  changes close the thread (403 BLOCKED / ORG_SUSPENDED / CHANNEL_CLOSED);
  history retained, org channel lists carry `closed: true`.
- **Auth**: dev logins (passwordless seeds, credential-less orgs) refused when
  `NODE_ENV=production` unless `ALLOW_DEV_LOGINS=1`; orgs can provision a
  password at grassroots registration (hash stripped from every response via
  `orgSafe`); org login accepts `password`. Richer `/health`.

Clients:
- **Player**: demo only via `EXPO_PUBLIC_DEMO=1` (live default
  `EXPO_PUBLIC_API_URL` → localhost:4000 — a missing var never selects mock);
  `client.ping()`; onboarding shows an actionable backend-outage card; root
  error boundary in `_layout`; ticketed SSE with reconnect + status
  ('reconnecting' banner in tabs); Threads outbox (pending/failed/retry,
  clientMsgId); identity switches/logout clear all fetched state.
- **Pro (scoutbox-club)**: user-facing "ScoutBox Pro" branding; ticketed
  SSE (`onChange(session, cb)`), live/reconnecting pill, Messages outbox with
  retry + closed-thread notice/composer lock, root error boundary.
- **Grassroots**: same M11 treatment (unbranded).
- Demo builds explicitly flagged; expo exports use `--clear` (Metro caches
  inlined env — a poisoned cache shipped a live bundle as "demo" once).

Ops: `scripts/dev-all.mjs` (port checks, whole stack, URL sheet,
`--with-admin`), `.env.example` × 4, README local-dev section (install,
seeding, LAN phone, test accounts). CI runs connectedE2E.

Verification: 23 unit · 129 apiE2E · **32 connectedE2E** (SSE auth/scoping/
replay, signed media incl. wrong-org refusals, idempotency, block/suspension
mid-channel, SIGKILL durability, prod login gate) · demoOffline + crosstab +
uiSpotcheck (rebuilt bundles) · **liveIntegration** (separate browser
contexts, isolated backend: Pro↔adult with numeric badges/read receipts,
Grassroots↔local adult, Pro↔guardian of a minor, reload persistence, outage
UI) · dev-stack smoke via the launcher · tsc + production builds × 4.
Native-device (iOS/Android) testing NOT performed — web only.

## Milestone 10 (2026-09-03): the grassroots club toolkit + onboarding redesign

Server (`scoutbox-server/server.mjs`, all grassroots endpoints behind
`grassrootsOrgOnly` 403):
- **Squad**: `org.squad` (signings push onto it automatically with
  `source:'signing'`; manual adds validate `visibleToOrg`, off-platform rows
  are name-only). `squadView()` computes coverage per `POSITION_GROUPS`
  (GK/DEF/MID/ATT), `gaps` (<2 players) and `suggestedLookingFor`.
  GET/POST `/org/squad`, POST `/org/squad/:entryId/release` (availability →
  `available_now`, contract → `free_agent`, optional club-authored PUBLISHED
  vouch — no email code, org identity is authenticated; moderated; ledger
  `released_by_club`; player + guardian notified).
- **Match days**: POST `/org/matchday` credits only rostered, visible platform
  players with `{verified:true, corroboratedBy: org.name}` attendance +
  `recordActivity`; `db.matchdays` keeps the club log (GET `/org/matchdays`).
- **No-ghosting**: POST `/org/open-trials` refuses `409 OUTCOMES_OUTSTANDING`
  while past open days hold registrations without an outcome. POST
  `/org/open-trials/:id/registrations/:regId/outcome` (`invite_trial` builds a
  full routed trial request inline — guardian routing, ledger, notifications;
  `declined` sends the kind no to player + guardian; note moderated; outcomes
  final `409 ALREADY_RESOLVED`).
- **Pathway Club record**: `pathwayRecord(org)` — involved ids from signings +
  squad + open-day registrations; `progressed` = later non-grassroots signing
  after first involvement; `pathwayClub` at ≥1. GET `/org/pathway-record`;
  exposed on `/orgs/directory` (grassroots rows) and `/player/opportunities`.
- **Federation verification**: POST `/org/verification/federation` files
  `org.federationCheck` (status `pending`, free-mail contact allowed) for the
  T&S console (`/admin/clubs`).
- **Friendlies**: `db.friendlies` — POST/GET `/org/friendlies` (own + within
  50km, responder messages visible to the poster only), POST
  `/org/friendlies/:id/respond` (moderated, one per club, poster's user
  notified via `postedByUserId`).

Grassroots app: Squad & Match Days screen (coverage stats with amber gaps,
one-tap "tell the radar", roster with release + reference flow, match-day
form with player checkboxes, history), Friendlies screen, outcome buttons +
no-ghosting banner on Open Days, Pathway Club record card + federation
verification form on Plan, and a **mobile pass** (≤860px: sticky scrollable
top nav, reflowed forms/cards, no horizontal scroll at 390px). Demo client
mirrors all of it (incl. a seeded past open day with unresolved registrants,
and the previously missing `Grassroots` plan in the demo `PLANS` map — the
demo Plan screen crashed without it).

Player app: **onboarding visual redesign** — crest hero with pills, role
cards, pair-code link, promises as check-lists, guardian step dots (1–5),
labelled fields, demo accounts with avatars. Every copy string, placeholder
and Enter-button order the e2e suites rely on is unchanged. Plus:
`corroboratedBy` on attendance (gold "coach-signed · <club>" pill on the
profile), 🌱 Pathway Club pills on the opportunity radar and club directory;
mock client mirrors.

Verification: 23 unit tests; **129-check API E2E** (34 new M10 checks:
squad/roster walls, match-day crediting, the outcome gate end-to-end, release
+ published reference, pathway record before/after an upward signing,
federation filing to admin, friendlies radius/moderation/response rules);
demoOffline + crosstab + uiSpotcheck browser suites green on rebuilt bundles;
M10 UI spot-check (outcome pills, gate toast, squad add/log, friendlies
respond, pathway card, 390px mobile, redesigned welcome, new player pills).
Artifacts republished at existing URLs (player, grassroots).

## Milestone 9 (2026-09-03): the Grassroots player journey

Everything from the "grassroots players shouldn't feel undervalued" review
except local leaderboards (deliberately excluded). All exclusive to
amateur/semi-pro (`grassrootsOnly` 403 for pros; `pathway: null`).

- **grassrootsJourney.mjs**: PROGRAMME_TRACKS (4 position tracks × 4 weekly
  sessions built on combine drills), trackForPosition, weekKey (Monday-anchored)
  + programmeProgress, pathwayFor (steps + signals + nextStep),
  earnedGrassrootsBadges (Turnstile/Ever-Present/Season Regular/Iron Streak/
  Combine Proven/First Club), percentileAmong (null under cohort of 3), inCohort.
- **Server**: /player/me gains pathway/programme/vouches/firstTeamSeeker;
  refreshJourneyBadges hooked into recordActivity + signings; level-up moment on
  signing (notify player+guardian, timeline entry); programme endpoints
  (GET/POST /player/programme, POST .../sessions/:id/complete → recordActivity);
  /player/benchmarks (cohort percentiles, "context, not competition");
  /player/opportunities (grassroots clubs ≤50km + lookingFor + open days);
  open trial days (org POST/GET/DELETE /org/open-trials grassroots-only w/
  moderated notes; player register adult-only + radius; guardian
  /guardian/children/:id/open-trials filtered by visibleToOrg + register);
  /org/looking-for; firstTeamSeeker endpoints (player adult / guardian child) +
  grassroots search sorts seekers first + view flag; coach vouches
  (db.vouches: request → mailer code "reference code is XXXXXXXX" → public
  POST /vouch/submit, moderated, single-use, coachEmail/code never in views;
  published vouches on all views of non-pro players; admin GET /admin/vouches +
  revoke); /player/season-wrap (best streak from activityLog, ledger view count).
- **Player app**: Home pathway card (3-step ladder + signal pills) + opportunity
  radar (register buttons, guardian-routed for minors); Upload training
  programme card (track picker ★ suggested, weekly checklist feeding streaks);
  Profile: First Team Seeker toggle (in availability card), cohort benchmark
  rows ("top N%"), Coach references section (list + adult request form);
  You: Season wrap card; Guardian: per-child open days + register, seeker
  toggle, vouch request. mockClient mirrors all (DEMO vouch auto-publishes 8s,
  canned benchmarks/opportunities, localStorage-free in-memory stores).
- **Grassroots app**: Open Days screen (post/manage/registrations w/
  U18-guardian pills), lookingFor editor, 🔎 First Team Seeker pill + sort
  boost, vouches in drawer; demo mirrors (Okafor seeded seeker, Kola vouch).
- **Club app**: coach references render in the player drawer when present.
- Tests: 23 unit (+4 journey), **95 API checks** (+25 M9), uiSpotcheck +
  offline suites extended and green; artifacts republished.

## Milestone 8 (2026-09-02): ScoutBox Grassroots

A fourth client app (`scoutbox-grassroots/`, Vite, port 5175, park-green +
kit-orange identity) and a hard platform split, all server-enforced:

- `org.level` ('grassroots'|'academy'|'pro'|'agency'), `org.location`,
  `org.federationRef`; `player.level` ('amateur'|'semi_pro'|'pro') +
  `player.location` (seeded from CITY_COORDS; optional lat/lng at signup;
  `POST /player/location`). New seed: Hackney Marsh Rovers (verified) + Moss
  Side Athletic (unverified) + London amateur pl-osei; pl-carvalho semi_pro.
- domain.mjs: `haversineKm`, `GRASSROOTS_RADIUS_KM=50`,
  `playerLevelAfterSigning`; `visibleToOrg` now also enforces (for grassroots
  orgs) the level ceiling and the 50km radius, failing closed on missing
  coordinates — every org endpoint inherits it via playerViewForOrg.
- Platform-scoped login (`platform:'grassroots'` in the login body;
  GRASSROOTS_PLATFORM_ONLY / PLATFORM_MISMATCH), `/orgs?platform=` filtered
  listings (main club app now requests platform=main),
  `POST /auth/org/register-grassroots` (federation + ground location required,
  starts unverified/adults-only, Grassroots plan £0).
- Grassroots views: `distanceKm` added; academyPlus/marketValueRange/agentName/
  contractUntil stripped server-side; search ranks nearest-first (no Academy+
  boost); signing sets player.level (grassroots→semi_pro, academy/pro→pro, the
  latter removing the player from Grassroots).
- The player app is UNCHANGED (per requirement).
- Client: fork of the club app; grassroots branding, pruned nav (no
  Reputation), radius banner + distance pills, club registration form on the
  login screen, standalone demo mode (no cross-tab bus) with a London cluster,
  a Manchester club, and a pro-level local proving the ceiling.
- Hosting/CI: served at `/grassroots` in the single container (Dockerfile
  stage added), CI job added, e2e suite extended (buildDemos/serve/offline).

Verified 2026-09-02: 19 unit tests, **70 API checks** (platform login gating,
filtered listings, radius visibility + 403 on direct fetch, minor rules
identical on Grassroots, pro-surface stripping, level transitions via
signings, federation-gated registration), grassroots live browser smoke
through `/grassroots`, offline demo E2E ×4 bundles, cross-tab + UI spotchecks
still green.

## Milestone 7 (2026-08-21): production hardening

Everything implementable of the "what next" review, in one pass. The principle:
real code paths with working dev transports; a single env var switches each
external integration live (see `DEPLOY.md`).

- **Auth** (`adapters.mjs` + server): scrypt password hashing (`scrypt$salt$hash`,
  constant-time verify, transparent upgrade of legacy plain-text), bearer-token
  sessions in `db.sessions` minted by every login/signup/pair (`createSession`/
  `sessionFor`), all four middlewares (player/guardian/org/admin-key) resolve the
  caller from the token — legacy `x-player-id`/`x-org-id` headers now 401.
  Passwords REQUIRED (8+) on new player + guardian signups; seed identities stay
  passwordless demo logins. `/auth/logout`. Fixed-window rate limiter on `/auth`
  (40/min/IP). Org sessions carry the individual user id — accountability now
  structural.
- **Guardian email verification**: signup mails a 6-char code (dev transport →
  `db.outbox`, response carries `devEmailCode` so the flow completes in-app),
  `/auth/guardian/verify-email`; child onboarding 403 `EMAIL_UNVERIFIED` until
  done. Player app onboarding is now 5 steps (account → email → IDV → disclaimer
  → child).
- **SQLite** (`store.mjs`): node:sqlite `DatabaseSync`, WAL, one row per
  collection written in a transaction; `db.json` imported once → `.migrated`;
  JSON fallback for old Node. Media blobs moved OUT of the snapshot to
  `data/media/*` via the storage adapter (`/media/:id` streams from disk).
- **Adapters** (`adapters.mjs`): mailer (SendGrid), push (Expo, with
  `/push/register` for device tokens + `db.pushLog` audit), IDV (Onfido seam,
  dev attestation with audit ref feeding the idvQueue), billing (Stripe seam;
  success fee by plan — signing inside the attribution window auto-issues into
  `db.invoices`), object storage (S3 seam, local disk in dev).
- **Funnel** `/org/funnel` from ledger + requests + trials + signings, with
  per-scout activity; club app "Funnel" nav renders bars + stage conversion %.
- **Club email-domain verification** `/org/verification/email(+/confirm)`:
  free-mail regex refused (422), challenge code mailed, confirm sets
  `org.emailDomain(Verified)`. UI in Plan & Compliance; invoices listed there too.
- **Moderation v2** (`domain.mjs`): obfuscated emails, spelled-out phone digits,
  more platforms (signal/wickr/kik/viber), and grooming patterns (secrecy,
  personal probing) with `severity: 'grooming'` — `moderateOrRefuse` logs an
  excerpt and auto-files an URGENT system report. Admin reports triage: urgent
  first, oldest first; moderation table shows severity; overview counts
  grooming escalations.
- **Admin console**: new Mail outbox + Billing tabs, overview stats (invoices,
  emails, sessions, storage engine).
- **CI** `.github/workflows/ci.yml`: 4 jobs — server (18 unit tests + 51-check
  `scripts/apiE2E.mjs` against a fresh seed), club/player/admin typecheck+build.
- **Deploy**: multi-stage `Dockerfile` — server serves built club at `/app` and
  console at `/console` (vite `--base`), volume at `/srv/data`; `fly.toml`,
  `render.yaml`, `DEPLOY.md` (adapter env-var table).
- **E2E suite moved into the repo** (`e2e/`): `buildDemos.mjs` (single-file
  bundles + player deep-path shim), `serve.mjs` (:8099), `demoOffline.test.mjs`,
  `crosstab.test.mjs`, `uiSpotcheck.test.mjs` (incl. guardian email gate +
  cross-tab pairing). Player demo pairing codes share via localStorage.
- **Not done (needs accounts/scope)**: real provider calls verified end-to-end
  (Stripe/SendGrid/Onfido/S3 need keys), native store builds, production CV for
  combine verification, i18n.

Verified 2026-08-21: 18 unit + 51 API checks (clean seed), SQLite restart
restore, offline demo E2E ×3 bundles, cross-tab messaging E2E, UI spotcheck
(email gate, pairing, funnel), live smoke through the Docker-style hosted club
app (`/app`) with token auth. All four apps `tsc` clean.

## Milestone 6 (2026-08-20): the messaging fix + the completeness pass

The reported bug — "player sends a message, club side sees nothing" — was demo-tab
isolation: two static artifact tabs each ran their own in-memory dataset (live server
mode always worked). Fixed with a cross-tab sync bus, plus notification pop-ups and
red unread-count badges on both sides:

- **Cross-tab demo sync** (`scoutbox-club/src/demoSync.ts` = `scoutbox-player/src/data/demoSync.ts`):
  BroadcastChannel `scoutbox-demo-bus` + localStorage journal (catch-up for late tabs)
  + presence heartbeats. Requests, accept/decline, messages, read receipts and typing
  flow between tabs; each demo suppresses its simulated counterparty while a real
  peer tab is present. Same-origin tabs only; live mode uses SSE as before.
- **Red unread badges** — club sidebar: `.nav-badge` count on Messages; player: count
  on the Inbox tab (pending requests + unread org messages, danger-red).
- **Pop-ups** — club: toast on fresh notifications; player/guardian: `PopupBanner`.

Platform-completeness features (all server-enforced, mirrored in both demo clients):

- **JSON snapshot persistence** — `scoutbox-server/data/db.json`, debounced writes +
  save-on-SIGINT; restart restores everything (gitignored).
- **Admin / Trust & Safety console** (`scoutbox-admin/`, Vite, port 5174, `x-admin-key`,
  default `scoutbox-admin`): overview, report queue (resolve with outcome + optional
  org suspension — resolution notifies the reporter), club verification, guardian IDV
  queue, suspensions, moderation log, thread audit.
- **Saved searches with alerts** — club saves filter sets; a matching new signup
  notifies the org (`saved_search` notification).
- **Trial logistics** — requests carry proposed date + up to 2 alt slots + venue;
  the player/guardian picks the slot when accepting; `.ics` calendar export per trial.
- **Trial report feedback** — `strengthNote` / `focusNote` on the mandatory report,
  shown on the player profile ("💪 Strength / 🎯 Work on").
- **Record signing** — attribution-window check writes `db.signings`; proof for the
  success-fee model.
- **Season history** — stats posted with a `season` label file into
  `seasonHistory` (career season-by-season table on the profile) instead of the
  current season.
- **Child device pairing** — guardian mints a single-use 6-char code (15-min expiry,
  crypto-random); the child's device exchanges it for the limited player login.
  Demo mode shares codes across tabs via localStorage.
- **Aging-up** — at 18 a guardian-linked player sees the handover card; completing it
  transfers ownership (history intact, both sides notified). Seeded: `pl-imani`.
- **Notification prefs** — quiet hours + school-hours mute (default-on for minors);
  muted pushes defer but the in-app feed always records.
- **Data rights** — full JSON export (player + guardian incl. children); account
  deletion (minors must go via the guardian; append-only ledger keeps ids only).
- **Club directory** (`/orgs/directory`) — the player-facing accountability view:
  verified badge, safeguarding-certified, trials run, reports filed, avg days to file.
  Clubs only — agencies never appear.
- **Org notes + "More like this"** — private per-org notes on profiles; similar-player
  jump-off from any profile drawer.

Verified 2026-08-20: 17 domain tests + **36 live API checks** (`m6-api-e2e`: pairing
single-use, slot choice → trial date → ICS, season filing, prefs, saved-search alert,
directory, mandatory report w/ feedback, guardian slot choice, exports, delete rules,
aging-up, signing, admin resolve → reporter notified, snapshot persistence + restart
restore). Cross-tab Playwright E2E: request → popup → accept → message → red badge
"1" on the club tab → reply back; offline single-file demo E2E for both artifacts;
M6 UI spotcheck (directory card, slot picker, seasons, prefs/export/delete, guardian
pairing → cross-tab pair → child lands on Home).

## Milestone 5 (2026-08-20): social-layout patterns + unique features

Adopted from the cross-platform analysis (everything except the club directory), all
server-enforced first and mirrored in both demo clients:

- **Home feeds both sides.** Club app now lands on a feed (`/org/feed`: new players,
  fresh footage with shortlist priority, reports coming due). Player Discover tab became
  a Home feed (`/player/feed`): weekly scout report card, streak, goal progress,
  scouting events, "what scouts noticed".
- **Film Room** (`/org/filmroom`) — full-screen vertical clip deck (arrow keys/buttons),
  Verified Clips surface first, overlay actions + structured scout tagging; every play
  is recorded as a clip view.
- **Verified Clip™** — `POST /player/media` with `attendanceId` links footage to a
  GPS+device-confirmed fixture (must include the actual file). Seal shows everywhere:
  Film Room, feeds, profiles, thread attachments. Seeded sample webm clips live in
  `scoutbox-server/assets/` (loaded at startup) and are inlined into the club demo.
- **Streaks / weekly goals / trust tiers / next-best-actions** — `domain.mjs`
  (`computeStreak`, `weeklyGoal`, `trustTier`, `nextActions`; kid-safe: self-competition
  only, no leaderboards). Activity recorded on uploads, attendance, stats, drills.
- **Richer messaging** — read receipts (`readBy`, `/channels/:id/read`), typing
  indicators (SSE `typing` events, `/channels/:id/typing`), attachments (player/guardian
  attach clips, orgs attach filed trial reports — validated server-side).
- **Per-clip analytics** — clip views + tag aggregation on media; 8-week view trend
  (`weeklySeries` in insights) drawn as bars on the player home.
- **"What scouts noticed"** — structured tag vocabulary (`SCOUT_TAGS`), aggregated
  anonymously to the player; ledger records `clip_tagged`.
- **At-home verified combine** — drills carry metrics/benchmarks; results logged with a
  value; attaching video marks them combine-verified (prototype: video presence;
  production = CV analysis). Visible to clubs on profiles.
- **Fixture-graph scouting** (`/org/fixtures`) — verified attendances grouped into real
  fixtures; club Fixtures screen opens each match to who provably played.
- **Portable Verified Sports CV** (`/player/cv`) — the player-owned record (identity,
  trust + tier, attendance, verified clips, trial reports, combine, timeline); CV
  preview card on the profile.
- **Weekly parent digest** (`/guardian/digest`) — per-child views, requests, streaks,
  activity; card at the top of the guardian dashboard.
- **Safeguarding Certified** — computed (`verified + contract + no unresolved urgent
  report`), shown in the club topbar, org listings and on requests to guardians.
- **Polish** — pull-to-refresh on player screens, skeleton loaders on the club feed.

Deliberately NOT adopted (the absence is the USP): public likes/comments/followers,
open DMs, algorithmic virality for minors, contact syncing.

Verified 2026-08-20 (Playwright + API, live server + offline demos): feed lands first
with certified badge; Film Room plays the seeded Verified Clip first and tags flow into
the player's "what scouts noticed"; fixtures list from attendance; player home shows
weekly report/streak/goal/next actions; profile shows tier + verified seal + CV; thread
carries a verified-clip attachment with read receipts; guardian digest renders. 17
domain tests pass.

## Milestone 4 (2026-07-23): closing the user-experience gaps

Everything below is server-enforced first, mirrored in both demo clients.

- **Message threads** — the payoff of the request flow now exists. A channel opens ONLY
  when a request is accepted (`openChannel`); org side `/org/channels`, adult players
  `/player/channels`, guardians `/guardian/channels`. Children have no threads, ever.
  Every message is moderated (contact details blocked) and lands on the ledger.
  Club app: Messages screen with thread view; player app: threads in Inbox (adults) and
  the guardian dashboard (minors' threads).
- **In-app notifications** — `db.notifications` per audience, `/…/notifications` (+ mark
  read) for org users, players and guardians; fired on request received, accepted,
  declined, message received, trial report filed, report resolved. Bell with unread badge
  in both apps. (Push/email delivery is production infra behind the same records.)
- **Real video upload & playback** — `POST /player/media` accepts a data URL (~12MB cap,
  in-memory store; production = object storage behind the same endpoint), served at
  `GET /media/:id`. Web file picker in Upload; playback in the club profile drawer and
  the player profile (`WebVideo`, native playback ships with expo-av).
- **"Who's watching you" insights** — `/player/insights` + `/guardian/children/:id/insights`:
  weekly/monthly view counts, per-org breakdown, recent attributed events. Card on the
  player Discover tab; per-child line in the guardian dashboard.
- **Trial logistics** — trial requests carry proposedDate/venue/notes (moderated); trials
  gain `reportDueAt` (+7 days); shown on both sides before accepting and on the Trials screen.
- **Guardian-initiated availability** — `/guardian/children/:id/availability`
  (open to trials / from end of season / not seeking) with dashboard controls.
- **Co-guardian** — `/guardian/coguardian` adds a second parent sharing the children;
  must still pass ID verification + disclaimer before acting.
- **Report outcomes** — reports resolve with an outcome (prototype 45s review timer;
  production = human T&S queue behind the same status fields) and notify the reporter;
  "safety centre" lists in both apps.
- **Search filters** — age group (U16/U18/18–21/senior), country, "new this week"
  (players now carry `createdAt`).
- **Persisted sessions** — both apps store the session in localStorage and restore on
  refresh (club re-mints its user id on restore since the server is in-memory).
- **Optional passwords** — signup accepts a password; login then requires it (plain-text
  prototype store, stripped from every API response; production = hashing + sessions).
- **Onboarding polish** — DOB auto-formats with live age feedback ("You're 14 — a parent
  or guardian sets up the account").

Verified 2026-07-23 (Playwright + API, live server): insights card and inbox badge render;
adult accepts trial → thread opens → messages flow both ways with org identity shown as
"Maria Keane · Head of Recruitment · Eastport FC"; org gets notified of replies; guardian
accepts → adult-to-adult thread works; moderation blocks a phone number inside a thread;
trial carries venue/date and a report deadline; demo builds replay all of it offline.

## Milestone 3 (2026-07-23): U18 + guardians

Adults-only launch is over: under-18 players now exist, protected by a guardian system
enforced server-side. Summary of the new rules (all in `scoutbox-server`):

- **Guardian accounts own every U18 profile.** `POST /auth/guardian/signup` →
  `/guardian/verify-id` (prototype IDV attestation) → `/guardian/disclaimer` →
  `/guardian/children`. Both gates are hard 403s. Minor self-signup → `403 GUARDIAN_REQUIRED`.
- **Scout → Parent, never Scout → Child.** Requests to minors get `routedTo: 'guardian'`;
  the guardian inbox (`/guardian/inbox`) shows club-first identity (org, Verified badge,
  sender's verified role); `/guardian/requests/:id/respond` opens an adult-to-adult
  channel on accept and creates the trial. The child's `/player/inbox` returns sanitized
  status notes only — no message content, no channel; child responds → `403 GUARDIAN_MANAGED`.
- **Verified clubs only** see minors (`verified` flag on org: company email domain +
  safeguarding contract). Unverified club → `403 VERIFIED_CLUBS_ONLY`; agency →
  `403 UNDER_18_WALL` (unchanged, now demoable — seed has Guni Adebayo 14 & Tomasz
  Kowalski 16 with verified guardians gd-amara / gd-marek).
- **Privacy for minors:** city + exact DOB stripped from every org view; profiles
  app-only; no comments/likes/followers anywhere in the API.
- **Moderation** (`domain.mjs moderateText`, prototype for an AI model): emails, phone
  numbers, social handles/platforms, URLs, off-platform meeting language →
  `400 MODERATION_BLOCKED` on request messages, media titles, timeline events.
- **Report & block:** `/player/report`, `/player/block`, `/guardian/report`,
  `/guardian/block`, `/org/report`. Urgent reports immediately suspend communication
  (blocks + freezes pending requests). One-click ⚑ Report/Block UI on every screen of
  both apps. All communications logged; guardians read the full ledger via `/guardian/log`.
- **Children keep the football:** media upload (moderated), verified attendance,
  timeline, stats editing (`POST /player/stats`) and drills (`/player/drills`) stay
  child-controlled; availability, Academy+, medical sharing and all club interaction are
  guardian-managed (medical via `/guardian/children/:id/medical/share`).
- **Player app:** guardian onboarding flow (4 steps), guardian dashboard route
  (`src/app/guardian.tsx`), child-aware tabs, and the Profile tab rebuilt to the
  approved design mock (avatar card + squad number, trust 59/100 card with breakdown
  bar, season-output tiles, availability chips, Academy+ card, contract status card
  with market value + agent).
- **Club app:** role picker at login (shown to parents), verified badges, U18
  guardian-managed profiles with "Contact Guardian" / "Invite to trial (via guardian)"
  actions, safety modal on every screen, unverified-club banner.

Verified end-to-end 2026-07-23 (Playwright, live server): club trial invite for the
14-year-old routes to the guardian; guardian sees "Eastport FC · Verified · Head of
Recruitment — Maria Keane" and accepts; child inbox shows only the sanitized update
with no accept button and no message text; child profile shows guardian-managed state;
moderation blocks a message containing a phone number; urgent guardian report suspends
the org's access. 13 domain tests pass (`npm test`).

## Migration note (2026-07-22)

The Mac-local Milestone 2 codebase was never pushed to this repo, so the full system was
**rebuilt from this handoff document** in a Claude Code web session and verified
end-to-end. Structure and behaviour follow this document; exact file contents differ
from the Mac originals. This repo is now the source of truth.

## What ScoutBox is

A football (multi-sport later) talent-discovery platform. Players build verified
profiles free from their phone; clubs and licensed agencies discover them through
a desktop recruitment OS. The core product promises: players never pay to be seen,
no unsolicited contact, every scouting action is attributed and auditable, and
minors are structurally invisible to agents.

## The three apps (this repo)

| Folder | What it is | Run |
|---|---|---|
| `scoutbox-server/` | Express sync backend both apps share. Enforces all deck rules server-side. In-memory DB seeded from `seed.mjs`. | `npm install && npm start` → port **4000** |
| `scoutbox-player/` | Player mobile app (Expo SDK 57 / React Native, expo-router, code under `src/app`). | `npm install && EXPO_PUBLIC_API_URL=http://localhost:4000 npx expo start --web` → port **8081** (omit the env var for self-contained demo mode) |
| `scoutbox-club/` | Club & agent desktop app (React 19 + Vite 8, landscape layout). | `npm install && npm run dev` → port **5173** (auto-connects to localhost:4000; override with `VITE_API_URL`; `VITE_DEMO=1` builds a self-contained demo) |

Start the server first. Both frontends then share one live dataset: a club's
contact/trial request appears in the player's Inbox instantly (SSE via `/events`);
a player's Academy+ toggle or upload appears in club search instantly.

To open the apps from other devices on the same Wi-Fi, run the frontends bound to
the network with the API env vars pointed at the host machine's LAN IP, e.g.:

```sh
VITE_API_URL=http://<host-ip>:4000 npm run dev -- --host          # club
EXPO_PUBLIC_API_URL=http://<host-ip>:4000 npx expo start --web --host lan  # player
```

**Demo logins (club app):** Eastport FC (club, Pro, Trusted Partner) ·
Harbour City FC (club, Academy) · North Star Sports Agency (agency — demonstrates
the under-18 wall). Pick an org, type any scout name, enter the workspace.

**Demo login (player app):** "Continue as a demo player" → Kola Adeyemi (maps to the
server's seeded `pl-adeyemi` in live mode).

## Deck rules — all enforced server-side in `scoutbox-server/server.mjs`, not just UI

- **Adults-only launch** — under-age sign-ups rejected by the API (`403 ADULTS_ONLY`), adult age per country (`domain.mjs`).
- **The under-18 wall** — agency accounts can never list, view or contact a minor, on every endpoint (`visibleToOrg`).
- **Scout Inbox** — no direct contact channel exists anywhere in the API; contact unlocks only when the player accepts a request (`contactChannel` stays null until acceptance).
- **Discovery Ledger** — every view/save/shortlist/contact/trial/signing timestamped to a named scout + org (append-only, `ledgerAppend`).
- **Accountability by user** — org requests without an individual `x-user-id` are refused (`401 USER_REQUIRED`). No shared accounts.
- **Proof Pack** — attribution evidence (first qualifying interaction, window, event log) generated on demand (`/org/players/:id/proofpack`).
- **Academy+** — opt-in only, player-controlled badges, boosted cohort in search, framed as a fresh start.
- **Fee protection** — attribution windows + anti-circumvention terms surfaced in Plan & compliance (`/org/plan`).
- **Trial Performance Reports** — MANDATORY after every trial (acceleration, sprint speed, distance, pass %, duel %, coach rating). Partial reports rejected (`400 REPORT_INCOMPLETE`); an org with an unfiled report cannot request new trials (`409 REPORTS_OUTSTANDING`); filed reports sync to the player profile and raise Trust Score.
- **Medical Reports** — player-controlled; stripped from every org view unless the player switches sharing on.
- **Availability + contract status** — player-displayed (available now / end of season / loans / overseas / not seeking; contract expiring etc.).
- **Verified Match Attendance** — fixture + venue + date + GPS + device id required (`400 ATTENDANCE_UNVERIFIABLE` otherwise); raises trust (prototype verification; production = geofence + device attestation).
- **Transfer Timeline** — career milestones on every profile.
- **Scout & Coach Reputation** — seeded track records + live rows computed from the Discovery Ledger (`/org/reputation`).
- **AI Similar Players Engine** — statistical similarity to reference archetypes (position, foot, age, output, physique) — a lead, not a verdict.

## Verified working (2026-07-22, end-to-end, headless browser + API tests)

- `scoutbox-server`: `npm test` → 11 trust/safeguarding domain tests pass.
- Guards confirmed against the running server: under-age signup **403 ADULTS_ONLY**,
  missing user id **401 USER_REQUIRED**, partial trial report **400 REPORT_INCOMPLETE**,
  new trial request with unfiled report **409 REPORTS_OUTSTANDING**.
- Club app (Playwright, real browser): login as Eastport FC → search (10 players,
  Academy+ cohort first) → profile view (ledger logged, similar players returned,
  medical locked notice shown) → contact request → ledger shows all rows.
- Player app (Playwright, live mode): onboarding age gate blocks a minor with the
  adults-only screen → demo identity login → **the club's contact request is in the
  player's Inbox** (org ids stripped, org name + scout name shown) → accept →
  contact channel opens. Trust breakdown renders and matches the server (59 for the
  seeded striker).
- Both frontends build clean: `tsc` strict + `vite build` (club), `tsc` +
  `expo export --platform web` (player). Node v24, npm 11.
- Note: the under-18 wall can't be demoed with current seed data — adults-only
  launch means no seeded minors exist for an agency to be blocked from. The code
  path is there (`isAdult` gate via `visibleToOrg`) and covered by `npm test`.

## Architecture notes

- Server storage is **in-memory** (restart = reset to seed). JSON snapshot / SQLite
  persistence is still a candidate next task. API surface is designed to swap to
  Postgres without changes.
- Live sync is Server-Sent Events (`GET /events`); clients refetch on any event.
  The player app falls back to 3s polling where `EventSource` is unavailable (native).
- Player app has two data clients: `src/data/httpClient.ts` (live server) and
  `src/data/mockClient.ts` (demo mode), selected by `EXPO_PUBLIC_API_URL` in
  `src/data/client.ts`.
- Player app: expo-router tabs (discover / inbox / profile / upload / you) under
  `src/app/(tabs)/`, onboarding flow with age gate (`src/app/onboarding.tsx`),
  domain layer (`src/domain/`) with trust-score + safeguarding logic mirrored by
  the server (`scoutbox-server/domain.mjs` is authoritative — keep in sync).
- Club app is React 19 + Vite 8, two source files of substance
  (`App.tsx`, `screens.tsx`), typed API client in `src/api.ts`. `src/demo.ts` is an
  in-browser mock (VITE_DEMO=1) used for self-contained demo builds only.

## Where we left off / candidate next steps (not yet chosen)

- Milestone 3 scope — to be defined by Younes from the original Claude chat sessions.
- Harden: persistence (JSON snapshot or SQLite), tests beyond `scripts/testTrust.mjs`, typecheck runs in CI.
- One-command startup for all three apps (launch config).
- Cloud deploy so the system is demoable anywhere (static demo builds of both apps
  were published as Claude artifacts from the 2026-07-22 session as a stopgap).

## Constraints to respect

- Local dev servers live inside whatever machine runs them; cloud Claude Code
  sessions can edit code and run the stack in-container, but the user's browser
  cannot reach those ports — use demo builds (artifacts) to hand the apps over.
- Never weaken a server-side rule in favour of UI-only enforcement — the deck's
  claims depend on the API refusing, not the frontend hiding.
