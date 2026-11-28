# Demo and alpha deployment: initial plan

Goal: put ScoutBox online as two separate instances of the same build:

| | `demo.scoutbox.io` | `alpha.scoutbox.io` |
|---|---|---|
| Who uses it | Tom, the founders, and the clubs and agents they demo to | Real people we invite: clubs, agents, players, guardians |
| Data | The seeded demo world (Kola, Amara, Eastport FC, …), reset whenever we like | Starts empty; everything in it is real and must be kept |
| Mode | `NODE_ENV=production`, `SCOUTBOX_SEED_DEMO=1` | `NODE_ENV=production`, `SCOUTBOX_SEED_DEMO=0` |
| Backups | Not needed: a reset is a re-seed | Essential: continuous, off-site, rehearsed |
| Gets a release | First | Only once the same image has been on demo |

Both serve the Player app and the four web portals (Pro, Grassroots, Agent, Trust & Safety console), with real
e-mail and real file storage. Box Cam video analysis is out of scope, but the plan leaves a place for it.

Written 27 Nov 2026 from the code on `main` (`a8ffb7e7`). Prices are list prices as last known; check them when
signing up.

## What we already have

- **One container image** (`Dockerfile`): the Gleam server as an Erlang shipment, plus the built Pro (`/app`),
  Grassroots (`/grassroots`), Agent (`/agent`) and T&S console (`/console`) portals, served same-origin by the server
  (`platform/portals.gleam`). CI already builds and boots it. Data lives on a volume at `/srv/data`.
- **`fly.toml`** (region `lhr`, a volume, health check `/healthz`) and `render.yaml`.
- **Production guard rails**: `NODE_ENV=production` refuses to boot without a strong `ADMIN_KEY` and `MEDIA_SECRET`,
  or with any test provider, fault rule, test clock or dev login switched on (`platform/config.gleam`).
- **Providers switched on by environment**: SendGrid (`SENDGRID_API_KEY`, `MAIL_FROM`), Expo push
  (`EXPO_ACCESS_TOKEN`), Cloudflare R2 (`R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`).
  Uploads go from the browser or phone straight to R2 on URLs the server signs; bytes never pass through the server.
- **The demo world on first boot** with `SCOUTBOX_SEED_DEMO=1`; without it, a production database starts with no
  people or organisations, and the first Trust & Safety reviewer comes from `TS_REVIEWER_BOOTSTRAP_*`.
- **Real onboarding paths** for an empty instance: player and guardian sign-up, Grassroots self-registration, and
  the verification application (`/auth/org/verification/apply`) for professional clubs, academies, agencies and
  other organisations, approved by T&S.
- **A backup route** (`POST /admin/backup`): a consistent copy of the database, plus a checksummed manifest. With R2
  configured it holds the database only. It writes to the same volume, so it is not an off-site backup on its own.
- SQLite runs in WAL mode, which is what continuous replication tools need.

## Gaps

### Both instances

1. **The Player app isn't in the image.** Add a build stage running `npx expo export --platform web` and serve it
   from the same container at `/player` (one `layout` entry in `platform/portals.gleam`, and Expo's
   `experiments.baseUrl: "/player"`). Same origin as the API means no CORS setup and one deploy for everything.
2. **Without SendGrid, production hands out the guardian e-mail code** in the sign-up response (known issue).
   Production should refuse to boot without a mail provider: a security fix, in scope under the freeze.
3. **`fly.toml` lets the machine stop when idle.** The server runs minute sweeps (offer expiry, reminders, delivery
   retries, webhooks) and holds live event streams; a stopped machine does none of that. Both instances stay on.
4. **Each R2 media bucket needs a CORS rule.** Browsers upload straight to
   `https://<account>.r2.cloudflarestorage.com`, so the bucket must allow `PUT`, `GET` and `HEAD` from its instance's
   origin with the signed headers. Without it every upload from the web fails.
5. **`SCOUTBOX_TRUST_PROXY` must be set behind Fly's proxy** (one hop), or every per-address limit (sign-in
   throttling, pairing attempts) keys on Fly's proxy and one bad actor locks everyone out.
6. **`MAIL_FROM` defaults to `noreply@scoutbox.app`.** Set it to an address at `scoutbox.io` on both instances
   (the SendGrid sender must be on an authenticated domain), and change the default in `messaging/transport.gleam`.
7. **Whether R2 enforces the signed checksum on a presigned PUT is unverified** (`platform/blobs.gleam`). Check it
   against a real bucket during setup.

### Demo only

8. **The seeded players and guardians can't sign in, and that's accepted.** They have no passwords, and production
   refuses passwordless logins (`DEV_LOGIN_DISABLED`). The demo is shown to clubs (and agents), whose seeded
   organisations get passwords through the T&S console (`POST /admin/clubs/:id/credentials`); the seeded players
   appear in their searches, Rooms and offers as data. The Player app is still served on demo, so a presenter can
   sign up a fresh synthetic player or guardian to show that side if asked. Running the demo outside production
   mode stays rejected: it would put dev logins, the test identity provider, fault injection and the public admin
   key default on the open internet.

### Alpha only: real people

The alpha is the first time ScoutBox holds real people's data, and the product is built for children. These are
mostly product and legal questions for the Founder, not code, but they decide whether the alpha can open.

9. **ID verification always approves** (no Onfido; known issue). On the alpha that means a guardian's identity, the
   safeguarding gate in front of a child's profile, is not actually checked. Options for the Founder: open the alpha
   to adults only (clubs, agents, adult players) until a real provider is integrated; or have T&S check every
   guardian by hand before their child's profile goes live, if the console's guardian ID review
   (`/admin/guardians/:id/idv`) can be made to hold rather than pass; or integrate a provider (a feature, after the
   freeze). Nothing in the code today stops a minor's account being created, so "adults only" is a policy we'd
   enforce by invitation, not a switch.
10. **Legal basics before any real person signs up:** a privacy notice and terms (the apps need somewhere to link
    them), registration with the ICO (the UK data protection fee), data processing agreements with Fly.io,
    Cloudflare and SendGrid (each offers a standard one), and a data protection impact assessment, which the
    Children's Code expects for a service children use. A named contact address (`privacy@scoutbox.io`) for
    requests.
11. **Known issues that matter once data is real** (`docs/known-issues.md`): a Grassroots club approved through a
    T&S application is placed in central London; the sign-in screens list every organisation; an invitation can bind
    to a colleague's existing account. None loses data, but each is visible to real users. Worth a pass over that
    file with the Founder before inviting anyone.

## Hosting: two Fly.io apps

**Recommendation: two Fly.io apps in London (`lhr`), `scoutbox-demo` and `scoutbox-alpha`, each one machine,
always on, with its own 1 GB volume, its own secrets and its own R2 buckets.** Nothing is shared between them
except the image, the Cloudflare and SendGrid accounts, and the domain.

Why Fly: the image and `fly.toml` already exist; TLS certificates, HTTPS redirect, health checks, restarts, secrets
and daily volume snapshots come with it; nothing to patch. SQLite means exactly one machine per instance (and the
rate limits are per process, known issue), which is Fly's simplest case. A VM (Hetzner CX22 at about €4/month)
would be cheaper but we'd own OS patching, the firewall, TLS, restarts and disk snapshots, twice over. The same
image runs on a VM with `docker run -v` if we ever move.

- **Config:** replace `fly.toml` with `fly.demo.toml` and `fly.alpha.toml` (same build and mounts; different app
  name, `SCOUTBOX_SEED_DEMO`, and machine size if wanted). Delete `render.yaml` and record the decision in
  `docs/decisions.md`, which currently says both targets are kept.
- **Releases:** build the image once in CI, deploy it to demo, smoke-test, then deploy **the same image** to alpha
  (`flyctl deploy --image …`). Alpha never runs a build that hasn't been on demo. Both deploys are run by hand.
- **Resetting the demo:** stop the app, delete and recreate its volume (or delete `scoutbox.db` from it), and start
  it: it boots with a fresh demo world. Then re-set the demo organisations' passwords (step 7). The demo media bucket can be emptied
  at the same time.
- **Cost:** a `shared-cpu-1x` machine with 512 MB–1 GB is about $5–7/month each; volumes about $0.15/GB-month;
  snapshots and traffic are pennies at this scale. **About $12–15/month for both.**

## DNS: pointing `scoutbox.io` at Fly

### 1. Put the DNS on Cloudflare (recommended)

We need a Cloudflare account anyway for R2, and its DNS is free and fast to change. Wherever `scoutbox.io` is
registered today:

1. In Cloudflare, *Add a site* → `scoutbox.io`, Free plan. Cloudflare scans and copies the existing records.
2. **Check the copied records against the current DNS before switching**, especially any `MX`, `TXT` (SPF, Google
   or Microsoft verification) and the apex `A` record, if the domain already has e-mail or a website. Anything
   missed stops working at the switch.
3. At the current registrar, replace the nameservers with the two Cloudflare gives you. It takes effect within a few
   hours, often minutes. (Optionally transfer the registration itself to Cloudflare Registrar later, which renews at
   cost; not needed.)

If we'd rather keep DNS where it is, the records below are the same; only the place you type them changes.

### 2. The app records

For each instance, after creating the Fly app:

```bash
flyctl certs add demo.scoutbox.io  -a scoutbox-demo
flyctl certs add alpha.scoutbox.io -a scoutbox-alpha
```

Then in Cloudflare DNS:

| Type | Name | Target | Proxy |
|---|---|---|---|
| CNAME | `demo` | `scoutbox-demo.fly.dev` | **DNS only** (grey cloud) |
| CNAME | `alpha` | `scoutbox-alpha.fly.dev` | **DNS only** (grey cloud) |

`flyctl certs show demo.scoutbox.io -a scoutbox-demo` reports when Let's Encrypt has issued the certificate (usually
minutes after the record resolves). It may also print an `_acme-challenge` CNAME to add; add it if so, because it
lets Fly renew the certificate without relying on the main record.

**Keep the records grey (DNS only), not proxied through Cloudflare.** Proxying would put a second proxy in front of
Fly's: certificate issuance needs the `_acme-challenge` record to work at all, the client address arrives through
two hops (so `SCOUTBOX_TRUST_PROXY` would have to trust Cloudflare's address ranges as well), and Cloudflare cuts
idle connections after 100 seconds, which would drop the apps' live event streams. Fly already provides TLS and
absorbs ordinary traffic. Revisit only if we need Cloudflare's firewall.

If the domain has a `CAA` record, it must allow Let's Encrypt: `scoutbox.io CAA 0 issue "letsencrypt.org"`. If it
has none, nothing to do.

The apex `scoutbox.io` and `www` are left alone (a marketing site, later). A Cloudflare redirect rule can send them
to `alpha.scoutbox.io` meanwhile if wanted.

### 3. E-mail records

Sending (SendGrid), set up once for both instances:

1. In SendGrid, *Sender Authentication* → *Authenticate your domain* → `scoutbox.io`, with automated security on.
   It gives three CNAMEs (`em1234.scoutbox.io`, `s1._domainkey.scoutbox.io`, `s2._domainkey.scoutbox.io`); add them
   in Cloudflare as **DNS only**, then click *Verify*. This is what keeps codes and invitations out of spam.
2. Add a DMARC record: `TXT _dmarc.scoutbox.io "v=DMARC1; p=none; rua=mailto:dmarc@scoutbox.io"`. Tighten `p=` to
   `quarantine` once reports show only SendGrid sending.
3. If the domain already has an SPF `TXT` record (from Google Workspace, say), leave it: SendGrid's automated
   security handles its own SPF through the CNAMEs.
4. **Turn off click tracking and open tracking** in SendGrid. Click tracking rewrites every link in our e-mails
   through SendGrid's servers, including invitation and verification links, and open tracking adds a tracking
   pixel to mail sent to guardians and children.
5. `MAIL_FROM`: `noreply@scoutbox.io` on alpha, `noreply@demo.scoutbox.io` or the same address on demo (a subdomain
   needs its own authentication in SendGrid; the same address is simpler).

Receiving: we need real inboxes for at least `privacy@`, `support@` and `dmarc@`. If the domain has no mail yet,
Cloudflare Email Routing (free) forwards them to existing addresses and adds its own `MX` and SPF records. If it
already has Google Workspace or similar, add the addresses there instead.

## Services to sign up for

| Service | What for | Cost (approx.) |
|---|---|---|
| **Fly.io** | Runs both instances | $12–15/month for two, card required |
| **Cloudflare** (account) | DNS for `scoutbox.io`, R2, e-mail forwarding | Free |
| **Cloudflare R2** | Uploaded files per instance, alpha's database backups, later Box Cam recordings | 10 GB storage and the request tiers free each month, then $0.015/GB-month; no egress fees. Likely free for the alpha |
| **Twilio SendGrid** | Guardian sign-up codes, club verification e-mails, staff invitations, notifications | No free plan any more: a trial, then Essentials from about $20/month. One account, one API key per instance |
| **ICO registration** (UK data protection fee) | Required before the alpha holds real people's data | About £50/year for a small organisation |
| **Password manager** (1Password, Bitwarden) | Production secrets for both instances and the demo passwords, shared with the founders | Free to ~$5/user/month |
| **Uptime check** (Better Stack, UptimeRobot) | A text or e-mail when an instance is down | Free tier |
| **Error tracking** (Sentry) | Seeing crashes in the apps | Optional; free developer tier |
| **Expo (EAS)** | Push notifications and native Player builds | Later; free tier is enough |
| **Apple Developer Program** | Native iPhone app via TestFlight | Later; $99/year |
| **Google Play Console** + **Firebase** | Native Android app and its push credentials | Later; $25 once, Firebase free |

Already have: GitHub (CI) and the domain. Not needed yet: Onfido and Stripe have no integration, and production
refuses to boot with their keys set.

**Monthly bill for both instances, web only: about $35**, plus the ICO fee yearly.

### Web or native Player app?

**Web first, on both instances**: the Player app already exports for the web, works in a phone's browser, and
Box Cam (the main reason for native camera access) is out of scope. What web loses is push notifications: players
and guardians see notices in the app instead. Native builds come later (step 12) and would point at alpha.

## R2 layout

One Cloudflare account; one bucket per purpose per instance; one API token per bucket, so a leaked demo key can
never touch alpha's data:

| Bucket | Used by | Token |
|---|---|---|
| `scoutbox-demo-media` | demo server | read/write, this bucket only |
| `scoutbox-alpha-media` | alpha server | read/write, this bucket only |
| `scoutbox-alpha-backups` | Litestream and the nightly job on alpha | read/write, this bucket only; never the server's |
| `scoutbox-demo-boxcam`, `scoutbox-alpha-boxcam` | later, Box Cam recordings | see below |

Each media bucket's CORS rule allows only its own origin (`https://demo.scoutbox.io` or `https://alpha.scoutbox.io`).

## Database backups

**Alpha** gets three layers; each protects against something the others don't.

1. **Continuous replication with Litestream** to `scoutbox-alpha-backups`. Litestream runs in the container, follows
   SQLite's WAL and ships changes every second or so, with periodic full snapshots. A lost machine or volume loses at
   most a few seconds of data. Restore is `litestream restore` into an empty `DATA_DIR`, then boot, which is how
   the server's own backups are restored too. Keep 30 days of point-in-time history to start with.
   - Packaging: add the Litestream binary to the runtime image, and have the entrypoint run the server under
     `litestream replicate -exec …` when the replica settings are present and run it plainly when they aren't, so
     the one image serves both instances.
   - Litestream must be the only thing that checkpoints the WAL in a way that discards frames. The server sets WAL
     mode and a busy timeout and doesn't force checkpoints, which is what Litestream wants; confirm it under load.
2. **Fly volume snapshots**: on by default, daily; raise retention to the maximum. They cover the whole volume but
   live with the same provider.
3. **A nightly server backup copied off-site**: a scheduled GitHub Actions job calls `POST /admin/backup` and
   `POST /admin/backup/verify` on alpha and uploads the result to `scoutbox-alpha-backups` under `nightly/<date>/`,
   then prunes the copies on the volume so `DATA_DIR/backups` doesn't fill it. An independent, checksummed copy made
   by our own code, in case Litestream ever fails.

**Restore drill** before the first real person signs up, and after any change to the backup setup: restore
Litestream's copy onto a scratch Fly app, boot it, sign in, and check a known record. A failed restore costs nothing
while the alpha is empty; that is why to rehearse it then.

Uploaded files stay in R2, which Cloudflare replicates. R2 has no object versioning, so the protection is the scoped
tokens above: only the alpha server can write or delete alpha's media.

**Demo** has no backups beyond Fly's default snapshots. Its data is the seed, and a reset is a re-seed.

## Box Cam later

Box Cam's analysis will run as a separate CV service (`box-cam/docs/architecture.md`). Its contract is decided: the
phone uploads the recording straight to R2 on a URL the API signs at `cv/begin`; at finalize the API gives the CV
service a short-lived signed **read** URL; the service returns a result; the API deletes the recording. To slot in:

- **A recordings bucket per instance** (`scoutbox-demo-boxcam`, `scoutbox-alpha-boxcam`), each with a lifecycle rule
  deleting anything older than 24 hours, as the architecture requires. A separate bucket keeps that rule from ever
  touching player media; object keys today are plain ids with no prefixes (`platform/blobs.gleam`), so a prefix rule
  in the media bucket would need a key-format change anyway. Each server gets a second bucket setting and a token
  for its own recordings bucket.
- **One CV service can serve both instances.** It holds no data and no R2 credentials: it reads only through the
  signed URLs an API hands it, so a compromise exposes only recordings in flight. Give each API its own secret for
  calling it, so demo can be cut off without touching alpha. A second CV deployment for alpha only is easy later if
  we want to test engine versions on demo first.
- **Private network.** On Fly, deploy it as a third app in the same organisation and call it at
  `<app>.internal`, with the per-instance secret or signed requests on top. It needs no public address and no DNS
  record. CV work is CPU-heavy, so it is sized and scaled separately (a `performance-` machine, or a GPU host
  elsewhere). If it lands on another provider, use mutual TLS or a signed job hand-over instead.
- **London region**, near the buckets and the APIs, for upload speed and to keep recordings of minors in the UK.
- Nothing needs building now; the CV routes stay a stub that answers `503`.

## Steps

Each step is one PR or one setup session. Steps 2–3 are code (tests and batteries as `CLAUDE.md` requires); the
rest are mostly setup. Steps 1–9 get demo online; 10–11 open alpha.

1. **Decide** (Tom): web-only Player, Fly.io, DNS on Cloudflare. Record them in
   `docs/decisions.md`. Raise Gaps 9–11 with the Founder now, since they gate the alpha and take longest.
2. **Close the code gaps**:
   - Production refuses to boot without a mail provider (Gap 2), with its battery.
   - Player web export in the image at `/player` (Gap 1); CI's image boot checks it is served.
   - `MAIL_FROM` default at `scoutbox.io` (Gap 6).
   - Litestream in the runtime image, switched on by its settings (Backups).
   - `fly.demo.toml` and `fly.alpha.toml`: always on, `SCOUTBOX_TRUST_PROXY=1`, health check on `/readyz`.
     Delete `fly.toml` and `render.yaml`.
   - Update `docs/product/platform.md` (Deployment) and `scoutbox-server/README.md` (Operations) in place.
3. **Deploy workflows**: a GitHub Actions job run by hand (`workflow_dispatch`) that deploys `main`'s image to demo
   after CI is green, and a second that deploys the image currently on demo to alpha. Deploys stay an explicit
   action.
4. **Cloudflare**: create the account; add `scoutbox.io` and move its nameservers (DNS step 1); create the demo and
   alpha media buckets and the alpha backups bucket, a scoped token for each, and each media bucket's CORS rule.
   Check Gap 7 with a deliberately wrong checksum.
5. **SendGrid**: create the account; authenticate `scoutbox.io` (DNS step 3); turn off click and open tracking;
   create a mail-send-only API key per instance; send a test. Set up the `privacy@`, `support@` and `dmarc@`
   addresses.
6. **Fly.io demo**: create the organisation and `scoutbox-demo` (`flyctl launch --no-deploy`), its volume
   (`flyctl volumes create scoutbox_data --region lhr --size 1 -a scoutbox-demo`), and its secrets: `ADMIN_KEY`,
   `MEDIA_SECRET`, the four `R2_*`, `SENDGRID_API_KEY`, `MAIL_FROM`, the `TS_REVIEWER_BOOTSTRAP_*` trio. Generate
   each with `openssl rand -hex 32` and keep it only in the password manager. Add the certificate and the `demo`
   CNAME (DNS step 2).
7. **First demo deploy.** Then: `/healthz` and `/readyz` answer at `https://demo.scoutbox.io`; the T&S console signs
   in; give each demo club and agency a password (`POST /admin/clubs/:id/credentials`); store them in the password
   manager for the founders.
8. **Smoke test the main journeys** on demo, from a laptop and a phone. First the club side, which is what gets
   demoed: Pro, Grassroots and Agent sign-in, player search, a Room, a trial, an offer, an agent workspace, a T&S
   review, an e-mail notification, an upload (lands in R2). Then the player side with freshly signed-up synthetic
   accounts: guardian sign-up with a real e-mail code, child pairing, a profile and a media upload. Record failures
   in `docs/known-issues.md`.
9. **Uptime checks** on both hostnames' `/readyz`.
10. **Fly.io alpha**: as step 6 for `scoutbox-alpha` with its own secrets (none copied from demo),
    `SCOUTBOX_SEED_DEMO=0`, its own buckets and tokens, plus Litestream's settings. Add the certificate and the
    `alpha` CNAME. Deploy demo's image. Set up the nightly backup job and snapshot retention, and run the restore
    drill.
11. **Open the alpha**, once the Founder has settled Gaps 9–11: onboard one organisation of each kind through the
    real paths (Grassroots registration; a verification application approved in the T&S console) and one adult
    player, end to end, before inviting anyone outside the team. Then invite people in small groups.
12. **Later: native Player apps.** Expo account and EAS project; Apple Developer and Google Play accounts; Firebase
    for Android push; `EXPO_ACCESS_TOKEN` as an alpha secret; `eas build`, distributed through TestFlight and Play
    internal testing, pointed at `alpha.scoutbox.io`.
13. **Later: Box Cam's CV service**, per the section above.

## Reminders for whoever runs the demo

- Everyone in the demo world is synthetic. Demo visitors shouldn't enter real children's details there either: ID
  verification is simulated, and the demo may be reset at any time.
- Real people go to alpha only, never to demo; and demo data never moves to alpha.
