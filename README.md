# ScoutBox — Full System (Milestone 3: Under-18 Safeguarding)

Three pieces, one live dataset:

| Folder | What it is | Run |
|---|---|---|
| `scoutbox-server/` | The sync backend both apps share. Enforces the deck's rules server-side. | `npm install && npm start` (port 4000) |
| `scoutbox-player/` | The player mobile app (Expo/React Native). | `npm install && npx expo start --web` |
| `scoutbox-club/`   | The club & agent desktop application (React, landscape). | `npm install && npm run dev` (port 5173) |

## Live sync
Start the server first. The club app connects to it automatically (localhost:4000).
To connect the player app to the same live data, start it with:
`EXPO_PUBLIC_API_URL=http://localhost:4000 npx expo start --web`
(without the variable it runs in self-contained demo mode).
Then: a club's contact/trial request appears in the player's Inbox instantly; a
player's Academy+ toggle or upload appears in club search instantly.

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
