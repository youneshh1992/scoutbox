# ScoutBox — Full System (Milestone 2)

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
- Adults-only launch: under-age sign-ups rejected by the API itself.
- The under-18 wall: agency accounts can never list, view or contact a minor.
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
