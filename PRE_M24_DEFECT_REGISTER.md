# PRE-M24 final defect sweep — defect register

Start state: `a5340aa` (M23 P8.1 R6), schema 2308. The sweep covered Player,
Club, Grassroots, Agent and Admin. It is a defect sweep, not a feature
milestone: every fix below is the smallest change that removes the root
cause. Nothing was redesigned and no M24A work was started.

Fix commits (local, not pushed):

| Round | Commit | Content |
|---|---|---|
| R1 | `ef968b3` | runtime, session, input and production-config fixes (PM-1–PM-6, PM-9–PM-13) + server regressions |
| R2 | `9f3f7f7` | keyboard and dialog accessibility fixes (PM-7, PM-8, PM-14) + the live browser regression suite |
| R3 | `637906d` | PM-15 boot-log drift fix + its regression; this register; the P8.1 deep-link matrix correction |
| R3b | this commit | TH-6: no server suite can draw a port that `fetch()` refuses (test harness only; no product file changed) |

New regression suites:

- `scoutbox-server/scripts/preM24SweepE2E.mjs` has 36 checks, 23 of them negative.
  - S0: the boot log carries no event-registry drift warning.
  - S: session lifetime and revocation.
  - A: an async handler failure no longer ends the process.
  - T: 21 malformed bodies on 14 routes.
  - P: production boot with an unsafe admin key or test providers.
  - H: no suite can draw a port that `fetch()` refuses (TH-6).
- `e2e/preM24SweepLive.test.mjs` has 30 checks, 22 of them negative, and runs against a real server and real Club, Grassroots, Agent and Player bundles.
- `m181E2E` §48 gains the PM-1 and PM-2 negatives.

## How the sweep was run

- **Route crawl.** A five-app crawler (not committed; it is a sweep tool) visited:
  - every Club route (66), Grassroots route (59) and Agent route (21);
  - every Admin tab (29);
  - every Player route, including the unmatched route and `/_sitemap`.

  Each ran in EN and FR at 360, 390, 768, 1024, 1280 and 1440 px, twice: on clean data and on planted hostile data. The planted data was:
  - 90-character player and organisation names;
  - broken photo and crest URLs;
  - unknown availability, contract and room-status enums;
  - an unreadable history timestamp;
  - an unknown history action with a nested detail;
  - a 500-character notification.

  Each visit recorded console errors, page errors, 5xx and 4xx responses, failed requests, blank screens, raw i18n keys, `undefined`/`NaN`/`[object Object]`/`Invalid Date` text, and horizontal overflow per width.
- **Targeted sweep.** 36 browser checks covering:
  - auth and session;
  - deep links while signed out;
  - double submit;
  - in-flight disable;
  - slow and failed requests;
  - dialogs and Escape;
  - listener leaks and duplicate re-reads;
  - stale sessions in every app;
  - hold/resume through the UI.

  Before the fixes: 18 passed, 8 failed. After the fixes: 36 passed, 0 failed, and 0 page or console errors.
- **Server sweeps:**
  - A type fuzz of 288 route × field × actor combinations. Before the fixes it produced 500s and stored objects; after, none (`filters` is an object by design).
  - Payload privacy: 61 Player, Agent and Guardian routes against private sentinels. 0 leaks.
  - Foreign versus fabricated ids on 19 detail and mutation routes. The answers were identical on all 19.
  - A production-config audit.
  - Session lifetime and revocation.
  - Async-handler failure.
- **Static checks:**
  - build warnings in all five apps;
  - date-only formatting in every app;
  - EN/FR key parity, which the `fr: typeof en` dictionary types enforce;
  - dev-only code paths;
  - listener cleanup.

## 1. Product defects

| ID | Sev | App | Route / component | Reproduction | Actual | Expected | Root cause | Fix | Regression | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| PM-9 | **Critical** | Server | `server.mjs` (all async route handlers); unauthenticated `POST /auth/guardian/signup` and `POST /auth/org/verification/apply`; authenticated `POST /org/verification/email` | One unauthenticated `POST /auth/guardian/signup` with `{"email":{}}` | The process exited (unhandled rejection); `/healthz` stopped answering for every user | 400 for the bad body; the server keeps serving | Express 4 forwards a *thrown* error to the error middleware but ignores the promise an `async` handler returns, so a throw inside one became an unhandled rejection | `m181/asyncErrors.mjs` patches `Layer#handle_request`, mirroring Express 4 line for line, so that a returned thenable's rejection goes to `next(err)`. The existing error handler answers 500 with its fixed body. The guardian signup body is also type-checked (PM-10), so this request now gets 400 | `preM24SweepE2E` A1–A5: throwing sync and async handlers return 500 and the app keeps serving; the original crash request answers 400; the server is still alive | Fixed (R1) |
| PM-1 | High | Server | `productionConfigProblems` (`m181/capabilities.mjs`); `ADMIN_KEY` | Boot with `NODE_ENV=production` and no `ADMIN_KEY` | The server started, and every `/admin/*` route accepted the public default key `scoutbox-admin`, which is in the repository | A production boot is refused until the deployment sets its own key | The admin key fell back to a published default and the production checklist had no rule for it | Fatal `ADMIN_KEY_UNSAFE` when the key is unset, is the default, or is shorter than 16 characters. The README states the rule | `m181E2E` §48 PM-1 ×3 negatives + positive; `preM24SweepE2E` P1–P4: a real production boot is refused, then starts with its own key; the default key gets 401 and the own key 200 | Fixed (R1) |
| PM-4 | High | Server + Club, Grassroots, Agent, Player | `sessionFor`, `/events`, signed media; each app's sign-out | Sign out, then reuse the token; or keep a token for months | Sign-out only cleared `localStorage`. The token stayed valid on the server indefinitely, including across restarts; `createdAt` was stored but never checked | Sign-out revokes the token; a session has a lifetime | No client called `POST /auth/logout`; the server had no session lifetime | Server: `SESSION_TTL_DAYS` (default 30), checked in `sessionFor`, at event-stream connect and on signed-media lookups. Expired and malformed sessions are refused and pruned. Clients: a keepalive `POST /auth/logout` on sign-out (Club, Grassroots, Agent); Player revokes and forgets the token | `preM24SweepE2E` S1–S9 (revocation, expired, missing or malformed `createdAt`, pruning, `SESSION_TTL_DAYS=1`); `preM24SweepLive` S1b (Club), S5b (Player) | Fixed (R1) |
| PM-3 | Medium | Club, Grassroots (+ event stream in all four apps) | `App.tsx` Workspace; `api.onChange` | 1) Sign out in tab A: tab B stays in the workspace. 2) An admin removes a colleague: the colleague's open tab stays in. 3) The event stream after a 401 | The workspace stayed mounted with every call refused, and the stream asked for a ticket every 15 s indefinitely. The P8.1 deep-link matrix said "the app signs the user out", which was only true at page load | The tab returns to the login screen, and the stream stops | A 401 was handled only at page load; the stream's retry treated 401 as transient | The notifications read, which runs on every refresh signal, signs out on 401; a `storage` listener follows cross-tab sign-out; the stream stops on a 401 ticket and emits `session_expired`, which signs out (Club, Grassroots, Agent, Player). The P8.1 matrix line is corrected | `preM24SweepLive` S2, S3a, S3b (0 ticket requests in 12 s), S4a, S4b; pre-fix targeted T1d, T1f, T1g, T7b and T7c failed and now pass | Fixed (R1) |
| PM-5 | Medium | Player | `state.tsx` boot, refresh and stream | Revoke or expire the Player token, then reload | Boot treated `PLAYER_AUTH_REQUIRED` as transient and kept the user "signed in" with every request refused | Back to the landing page | `NOT_FOUND` was the only code treated as a dead session | `isSessionEnded` (auth-required or session-invalid codes) → `endSession` at boot, in refresh and on `session_expired` | `preM24SweepLive` S5a | Fixed (R1) |
| PM-10 | Medium | Server | `/org/searches`, `/org/squad`, `/org/verification/email`, `/org/invites`, `/org/support`, `/org/verification/player-invites`, `/org/verification/licence`, `/auth/guardian/signup`, `/auth/org/register-grassroots`, `/auth/org/login`, `/player/media`, `/org/open-trials`, `/org/friendlies`, `/player/medical/records`, `/delivery/prefs` | Send an object or number where text is expected | Either a 500 (including on unauthenticated routes) or the object was **stored** and later rendered | 400 `FIELD_INVALID` naming the field; nothing stored | Handlers trusted body types | `optText`/`reqText`/`badField` in `server.mjs` and `typeof` checks in m13/m14; quiet hours must be `HH:MM`; medical record fields are typed (`layoffWeeks` 0–520, `cleared` boolean) | `preM24SweepE2E` T1–T3: 21 malformed bodies across 14 routes → 400, nothing stored, well-formed bodies still 2xx; fuzz re-run 0 × 500 and 0 stored | Fixed (R1) |
| PM-2 | Medium | Server | `productionConfigProblems` | `AGENT_VERIFICATION_TEST_PROVIDER=1` with `NODE_ENV=production` | Production accepted the agent test verification provider (the Box Cam twin was already refused) | Refused | Missing rule | Fatal `AGENT_TEST_PROVIDER_IN_PRODUCTION` | `m181E2E` PM-2; `preM24SweepE2E` P6 | Fixed (R1) |
| PM-7 | Medium (a11y) | Club, Grassroots, Agent | Top bar bell panel; phone navigation drawer; hamburger | Open the bell panel or the 390 px drawer with the keyboard, then press Escape | Nothing closed; the hamburger did not say whether the drawer was open | Escape closes and focus returns to the opener; `aria-expanded` | No key handling; no state on the button | Escape effect in the Workspace; `aria-expanded` and `aria-controls="app-sidebar"` on the hamburger | `preM24SweepLive` S6a–S6d | Fixed (R2) |
| PM-8 | Medium (a11y) | Club, Grassroots, Agent | `SafetyModal`, `CompareModal`, `PlayerDrawer` (7 drawers) | Open Report & block from the keyboard | Focus stayed behind the veil; Escape did nothing; 6 had no `role="dialog"` or `aria-modal` | A labelled modal dialog: focus moves in, Escape closes, focus returns | No dialog behaviour | `useDialog` hook (`dialog.ts`); `role="dialog"`, `aria-modal` and `aria-label` on each drawer | `preM24SweepLive` S7a, S7b, S7d, S7e | Fixed (R2) |
| PM-14 | Medium (a11y) | Club, Grassroots, Admin | Search player cards (×2), feed rows, list rows, player-name links without `href` (×4), expand toggles, case rows; Admin message-thread toggle (19 elements) | Tab through Search; press Enter on a card | Tab skipped the cards and Enter did nothing. A keyboard user could not open a player from Search | Keyboard controls | Clickable `div`s and `a`s with only `onClick` | `pressable()` helper: `role="button"`, `tabIndex 0`, Enter/Space on the element itself (keys on inner controls such as the compare checkbox are left to them). Admin gets the same inline, plus `aria-expanded` | `preM24SweepLive` S7c–S7f (S7c failed on the pre-fix bundles) | Fixed (R2) |
| PM-6 | Low | Player | Unmatched routes | Open an outdated link, e.g. `/opportunities/old-offer-link` | Expo's English developer page "Unmatched Route", with a link to `/_sitemap` | A translated ScoutBox not-found screen with a way home | No `+not-found` route | `src/app/+not-found.tsx` (EN/FR) | `preM24SweepLive` S8a–S8c | Fixed (R1) |
| PM-13 | Low (dev-only exposure) | Player | `/_sitemap` | Open `/_sitemap` on the production export | Lists every route source file, the Expo SDK version, the build mode and the origin | Nothing internal | expo-router serves its developer sitemap unless the app defines one | `src/app/_sitemap.tsx` re-exports the not-found screen | `preM24SweepLive` S8d | Fixed (R1) |
| PM-11 | Low (dev-only exposure) | Player | Landing (`listDemoIdentities`) | Open the Player app against a server with development logins off | Four passwordless "Enter" demo identities were offered, and every one failed with `DEV_LOGIN_DISABLED` | None offered | The list was unconditional | Asks `/health` for `devLogins`; returns `[]` when that is false or the server is unreachable | `preM24SweepLive` S9 | Fixed (R1) |
| PM-12 | Low (malformed data) | Club (same formatters in Grassroots and Agent) | Room hub, room activity, Organisation (history rows) | A legacy or damaged history row with an unreadable `at` | "Invalid Date" | A dash | Formatters passed any value to `Date` | A `badStamp` guard in `fmtDate`/`fmtDateTime`/`fmtTime`/`fmtStamp` (Club, Grassroots) and `fmtDate`/`fmtStamp` (Agent) | `preM24SweepLive` S11 (3 routes); planted crawl | Fixed (R1) |
| PM-15 | Low (pre-existing, D-P56B-12) | Server | Boot; `m23/decisionRoutes.mjs`; `EMITTED_EVENTS` | Start the server | Every boot logged `event registry lists names the server never emits: room_decision_finalized, room_decision_superseded`, a false drift alarm that trains operators to ignore the real one | A clean boot log | The decision route broadcast through a variable name, which the M18.2 source scan cannot see, so the two names were never declared in `EMITTED_EVENTS` (the same shape as D-P6-9) | Two literal `broadcast()` calls; both names declared in `EMITTED_EVENTS` | `preM24SweepE2E` S0; `m182E2E` source/registry agreement (420 checks); cold boot counts 0 drift warnings | Fixed (R3) |

Open product defects at Critical, High, fixable Medium or relevant Low: **0**.

## 2. Test-harness defects

| ID | Where | Defect | Effect | Fix | Status |
|---|---|---|---|---|---|
| TH-1 | sweep crawler (scratch) | Entered the Agent workspace by the English "Enter workspace" label, which the Agent app translates | The Agent FR pass never ran | Language-neutral selectors; the FR pass ran post-fix | Fixed |
| TH-2 | sweep crawler | The Grassroots room fixture used a player Moss Side cannot see (50 km rule) | Room tabs were not crawled for Grassroots | Uses `pl-adeyemi` via Moss Side | Fixed |
| TH-3 | sweep crawler | The planted-data run renamed Eastport, and the org-card selector used the full name | The Club planted pass could not sign in | Selector `Eastport` | Fixed |
| TH-4 | targeted sweep | T3a asserted that "Under review" was absent from the header, but it is also a Move-to option | False failure; the product was correct | Asserts on the next-action code instead | Fixed |
| TH-5 | `preM24SweepLive` S5a (during authoring) | Waited for landing text that sits below the fold on the landing variant | False failure; the product was correct (probe: 401 → landing) | Asserts landing text present and signed-in shell absent | Fixed before commit |
| TH-6 | 12 server suites (`m14E2E`, `m15E2E`, `m161E2E`, `m182E2E`, `m22E2E`, `m23AgentComplianceE2E`, `m23AgentPersistence`, `m23ContactE2E`, `m23DecisionE2E`, `m23DecisionPersistence`, `m23OfferPersistence`, `m23Persistence`) | Each draws a random base port and boots servers at fixed offsets from it. Those ranges reached ports the Fetch standard refuses (5060/5061, 6000, 6566, 6665–6697), and Node's `fetch()` fails with `bad port` before it opens a socket | Intermittent mid-suite death with rc=1 and no ✗ line. Seen once in the R3 gate (`m23DecisionPersistence`, 44 s) and reproduced 1 in 29 runs under load: `TypeError: fetch failed … cause: bad port` on `PORT + 6` = 6000. Roughly 3% of that suite's runs; other suites up to 1% | `scripts/testPort.mjs` `pickPort(base, range, offsets)` draws only bases whose every used offset is reachable; all 12 suites use it. Regression: `preM24SweepE2E` H1 (fetch refuses 6000), H2 (2,800 draws), H3 (no suite's reachable range touches a refused port). `m23DecisionPersistence` 60/60 after the fix | Fixed (R3b) |
| TA-1 | `m182E2E`, `connectedE2E` | Booted production without `ADMIN_KEY` / used the public key | Failed once PM-1 made that fatal, as intended | Both pass the deployment's own key, as they already did for `SCOUTBOX_MEDIA_SECRET`; `connectedE2E` gains a negative asserting the public key is refused. Not weakened: one check added, none removed | Adapted (R1) |

## 3. Cosmetic observations (not defects under the sweep policy)

| ID | Where | Observation | Decision |
|---|---|---|---|
| OBS-1 | `productionConfigProblems` | Checks `SCOUTBOX_ALLOW_DEV_LOGIN`, a name the server never reads. The real escape hatch `ALLOW_DEV_LOGINS=1` is deliberate: it logs a loud warning and is documented in the README | Recorded, not changed; removing the hatch would change deliberate behaviour |
| OBS-2 | Admin (internal tool) | Formats timestamps with `new Date(x).toLocaleString()` directly. Server stamps are always valid; the planted crawl produced no finding | Recorded |
| OBS-3 | Build | Club: `INEFFECTIVE_DYNAMIC_IMPORT` for `m13api` (it is also statically imported, so this is harmless) | Tool notice, no behaviour change |
| OBS-4 | 4xx during crawl | Only deliberate cases: concealed not-found on foreign or fabricated ids, `/org/representation` 403 `AGENCY_ONLY` for clubs, and the Agent trials 403 without `trial_projection` consent | By design |

## 4. Future design debt (M24 and later; not defects)

| ID | Area | Debt |
|---|---|---|
| DD-1 | Club IA | "Network / Representation" leads to a screen that only explains that representation is the agency lane. It is not broken, but a club navigation destination has no function |
| DD-2 | Performance | The Club and Grassroots main chunks exceed 500 kB; there is no route-level code splitting |
| DD-3 | Player EN/FR | The FR toggle covers navigation, tab titles and the M21–M23 surfaces, but about 87 older strings are still English literals (onboarding landing, guardian area, parts of You → Account, including the "Log out" label). The app works in both languages; this is copy and translation work, best done with the M24 design-system copy pass |
| DD-4 | Keyboard model | PM-14 made clickable rows reachable as buttons. The design system should replace them with real `<button>`/`<a href>` components and a single dialog primitive (today `useDialog` is copied into three apps) |
