# M18.1 — Production Hardening & UX Cleanup

M18.1 adds **no recruitment concept**. Every change below is a correctness,
privacy, honesty, reliability or clarity fix to something that already
shipped. Where a problem is only partly solved, this document says so and says
what remains — a limitation written down is worth more than one quietly
inherited by the next milestone.

Branch `claude/desktop-project-migration-wyk3ec`, baseline tip `01de385`.
Nothing pushed.

---

## 1. What M18.1 was for

M18 ended with a list of honest limitations. M18.1 exists to close as many of
them as can be closed properly, and to write down the shape of the ones that
cannot. The named starting points were: no optimistic concurrency on Brief
edits (A) or Room mutations (B); `passportVersion` fixed at the schema
constant (C); `current_club_confirmed` and `position_changed` declared but
never emitted for want of an honest clock (D); Combine invalidation detected
by exclusion (E); rate limits counted per process (F); and no scoped Trust &
Safety access path to M18 material (G).

All seven were addressed. Three are fully closed (A, B, D). Two are closed
with a stated boundary (C, E). One is architecturally prepared and
deliberately **not** claimed as solved (F). One is deliberately **not built**,
and documented instead (G).

## 2. Optimistic concurrency: the mechanism

`scoutbox-server/m181/concurrency.mjs`. Every collaborative record carries
`rev`, an integer that increments on every accepted mutation. A mutating
request may name the rev it was composed against; if the record has moved on,
the write is refused with `409` and the caller is told the current rev so it
can reload and re-apply.

Four decisions worth stating:

- **`rev` is not the Brief's `version`.** `version` is the *criteria* version
  that historical Evaluation Coverage points at, and it deliberately does not
  move when only a status changes. A concurrency token must move on every
  mutation, so it is a separate field. The conflict body carries both.
- **Both spellings are accepted.** `expectedRev` and `expectedVersion` mean the
  same thing, because callers think in the vocabulary they were given.
- **An absent token keeps the old behaviour.** Nothing that worked before
  M18.1 breaks; every ScoutBox surface now sends the token.
- **A malformed token is a 400, never a coercion.** `expectedRev: "latest"`
  must not silently become `0`.

## 3. What is versioned, and what deliberately is not

Versioned: Brief creates and edits, Brief status transitions, Room status
transitions, Room priority, lead scout, owner and restriction, and the
decision write.

Not versioned: comments, tags, tasks and notes. A lost update there is an
inconvenience, not a corrupted decision record, and demanding a rev for every
trivial edit trains people to send whatever number makes the error go away.

## 4. Concurrent decisions

The decision write is pinned to the room's rev, so of two simultaneous
submissions exactly one is accepted and the other is told the room moved.
Append-only history is unchanged: nothing edits an old decision, and the room
ends with at most one decision that is not superseded. Asserted in
`m181E2E §12b` by issuing both writes at once.

## 5. The client half — and why it mattered

The server half alone would have been theatre. Until the clients sent a rev,
every real ScoutBox surface still took the last-write-wins path. Both web apps
now send the rev they rendered from on brief edits, brief status changes, room
status transitions and room workflow patches.

`m181Live H2` is the only test that can establish this: it intercepts the
page's own status request, performs a colleague's transition while that
request is in flight, and asserts on **what the client actually put on the
wire**. No server-side test can answer "does the client pin its writes".

## 6. A conflict has to survive being seen

The first implementation surfaced the conflict as a toast. The live suite
caught a routine live-sync notification replacing it within a second — the one
message a user must not miss, gone before they read it. The Room panel now
keeps a `role="alert"` conflict notice with a Reload button until the person
acts on it. The Brief form already showed its message persistently.

The wording says the important part first: *nothing of theirs was
overwritten.*

## 7. Idempotency on repeatable actions

Decisions and uploads already had client keys. M18.1 adds state-level
idempotency where a double click was previously two transitions: Nobody Missed
add-to-room returns the **same** room with `idempotent: true` rather than
reporting a creation that did not happen, and a repeated Second Look review
does not append a second history entry.

## 8. The Passport revision

`passportVersion` was the schema constant `1`, so a decision snapshot could not
say which Passport truth it saw. M18.1 adds `passportRevision`: a SHA-1 over
canonical Passport inputs — position, level, identity assurance, current club,
club-history rows, evidence identities with their tier and superseded/expired
state, references, achievements, Combine results and career entries.

The rule that makes it useful: **nothing time-relative is an input.** A
revision computed from the same records a year later is byte-identical. If
"days since last evidence" were in the hash, the revision would change
overnight on a read, and a snapshot pinned to it would be meaningless.

Superseding evidence moves the revision too. Removal is a change, not an
absence.

## 9. Change clocks: the rule

Two M18 change types were declared and never emitted, because no honest clock
existed. The rule M18.1 adopted:

1. Where a canonical row already carries an honest clock, **read that clock** —
   a signing's `ts`, a squad row's `addedAt`, a verified claim's `verifiedAt`,
   a Box Cam session's invalidation time.
2. Where no clock exists at all, **append a new source-change event** at the
   write site, with the time it actually happened.
3. **Never borrow a timestamp that means a different event.**

`positionHistory.from` is the football date the player *started playing* the
position. `prefs.updatedAt` moves when any preference is edited. Neither dates
the change, which is why `db.sourceChanges` exists.

## 10. `position_changed`

Written at the preference site, and only when the primary position actually
changes value. Re-saving the same position emits nothing; editing an unrelated
preference emits nothing. Fingerprinted on `passport_prefs:<playerId>:<value>`,
so the same change seen through any projection is one change.

Proven end to end in `m181E2E §21`: three preference writes on one player
produce exactly one `position_changed` in the Second Look queue.

**Remaining limitation.** Position rows written before M18.1 have no clock and
deliberately emit nothing. They cannot be dated retroactively without
inventing a date, so they are not.

## 11. `current_club_confirmed`

Derived from rows that each carry their own genuine clock: a signing, a squad
membership, a verified affiliation claim. Fingerprinted per source row.

**Remaining limitation.** A club that confirms a current club with none of
those rows behind it still emits nothing. That is the honest outcome, not a
gap to paper over.

## 12. Combine invalidation

Invalidation used to be detected by exclusion, and restoring a session set
`invalidatedAt = null`, destroying the only clock there was. Box Cam sessions
now carry an append-only `integrityEvents` list: `invalidated` and `restored`
each with their own timestamp, and `combine_verified_invalidated` /
`combine_verified_restored` are first-class change types with copy that
accuses nobody.

One invalidation stays one change across the Combine projection, the Passport
timeline and Trust, because the fingerprint is the canonical **session id**,
not the projection that surfaced it.

## 13. Rate limiting: what is fixed and what is not

Before: six independent limiters — the adapter's IP limiter plus five
copy-pasted `limited(key, max, windowMs)` helpers with their own Maps — and
every limit written inline at its call site.

Fixed: `m181/rateLimit.mjs` names all thirteen limited actions in one policy
table, each with its window, its scope, and one sentence on what it protects,
so "what are we limiting, and to what?" is one file. Consumption goes through
a provider interface, so a shared backend can be added without touching a
single call site. An action not in the table throws — an unnamed action is a
programming error, not a silently unlimited route.

**Not fixed, and not claimed:** there is no shared backend. The memory provider
counts **per process**, which is correct for development, demo and a single
instance and **wrong** behind a load balancer, where each instance allows the
full quota. `/capabilities` reports `distributed_rate_limit: not_configured`
and says exactly that in words.

`SCOUTBOX_RATE_LIMIT_PROVIDER=distributed` is accepted as a request and
**refused loudly**. Silently falling back to per-process counting while an
operator believes they have distributed protection is precisely the quiet lie
this milestone exists to remove.

One limit kept its per-minute window on purpose: `room_comment` exists to stop
a runaway client or a spam burst in a live discussion, which an hourly window
would not catch.

## 14. Event delivery: fail closed

`shouldDeliver` inferred the audience from the shape of the payload, and its
last line was `return true` — an event with neither `orgId` nor `playerId` went
to every connected identity, players and rival clubs included. Today's such
events are harmless cache pings, but "safe because of what we happen to put in
the payload" is not a privacy model. M17 already shipped one leak of exactly
this kind.

`m181/eventAudience.mjs` classifies every event name into one of six
audiences, and `audienceFor` returns `org_private` for anything unknown. A new
event is therefore invisible until someone classifies it, which is the failure
we want: something not appearing is a bug report, something leaking is an
incident.

## 15. Privacy: the adult date of birth

Every organisation player projection carried a raw `dob` although no club
surface uses it — age is what is displayed, and minors already had it removed.
It is gone from the projection.

## 16. Terminology: two numbers, two names

Two different figures were both shown to scouts as "Trust": M16.2 evidence
confidence, and the older completeness signal (identity flag, recorded
attendance, filed trial reports, uploaded clips, profile fields).

The older one is now called **Profile completeness** everywhere, and ships as
`profileSignal` with `trustScore` retained as a deprecated wire alias so
nothing downstream breaks. **Trust Score** is reserved for evidence
confidence, in all three apps, EN and FR.

**Remaining limitation.** Discover still orders by that completeness figure.
The ordering is now stated rather than silently applied; changing it is a
product decision, not a hardening fix, and is flagged for a product milestone.

## 17. Provenance that never mislabels

`box_cam_observed` is a canonical provenance the server emits, and it was
missing from every client's table. Worse, the fallback asserted the weakest
*known* label — so evidence ScoutBox itself observed through Box Cam was
badged "Player-provided" in Pro and Grassroots, and rendered as its raw
identifier in the player app.

Box Cam now has its own label with the **neutral** pill: it ranks below a
ScoutBox review and must not borrow a confirmation colour. An unrecognised
provenance reads "Source not classified" and explains that nobody is being
credited with confirming it. Asserting the weakest known label is still an
assertion, and it was wrong.

## 18. Missing values are never scores

A Room whose evidence confidence could not be read showed "—",
indistinguishable from a withheld player and one glance away from reading as
zero confidence. Both cases now say which one they are.

In the player Combine surfaces only `combine_verified` and
`partially_measured` had words of their own, so an attempt invalidated after
review looked exactly like one the device could not measure. Every terminal
state now carries its own badge and the server's sentence for it, an
invalidated value is struck through and labelled as no longer counting, and a
null measurement prints "No measurement" rather than a formatted dash. The
client's `combineState` union was also missing five states the server sends.

## 19. Loading, error and empty states

A failed load in Second Look, Nobody Missed, Briefs, Review Changes and
Recruitment Rooms rendered the message and stopped. The only recovery from a
dropped connection was to navigate away and come back — not something a user
has any reason to guess. Each now offers a retry and announces itself with
`role="alert"`.

The four Second Look tabs shared one "Nothing in this queue". Each now says
what its own emptiness means: an empty *Worth another look* is the engine
finding no changes; an empty *Reviewed* is nobody having looked yet.

## 20. Notifications

**Coalescing.** `notify()` appended unconditionally, so the same sentence about
the same record could fill the bell and push a phone twice. An identical
**unread** notification within six hours now refreshes the existing row and
counts it (`repeatCount`), and sends no second push. Once **read**, a new
occurrence gets its own row — coalescing something the recipient has already
dealt with would hide that it happened again.

**Actionability.** The bell rendered the text and a clock and dropped both
`type` and `refId`, so a Recruitment Room task could not be reached from the
thing announcing it. Rows whose type has a known destination are now buttons to
it; a type with no mapped screen stays plain text rather than being sent
somewhere approximately right. The Second Look notification names the player —
"a player you previously archived" gave a scout who has archived dozens nothing
to act on.

**Remaining limitation.** There is no notification preference system. A person
cannot yet choose which of these they want.

## 21. Dates that do not mislead

The pre-M12 screens used the browser locale via bare
`new Date(x).toLocale*String()`, so switching ScoutBox to French left 25
timestamps in English. They now go through the app's own helpers. A new
`fmtStamp` gives the bell and message rows the time while it is still today
and the date once it is not — a bare "14:32" on a week-old row is the most
common way a feed timestamp lies.

## 22. Accessibility

Every confirmation and every failure in both web apps arrives through one
Toast element, and it was an unannounced `<div>`: a screen-reader user got no
signal that their action had succeeded or failed. It is now a live region —
`role="alert"`/assertive for errors, which interrupt what the user was about to
do next, `role="status"`/polite for confirmations, which do not. Verified in
the shipped bundles, not just the source.

The two emoji-only header controls (🔔, ⚑) had a `title` but no accessible
name; the bell now announces its unread count and expanded state. The Second
Look tabs take focus, are operable with the keyboard alone, and show a visible
focus indicator (`m181Live H8`).

## 23. Phone width

The shell already collapsed the sidebar at 900px, but several fixed pieces
still pushed a ~360px viewport sideways: the top bar could not wrap so its
status pills dragged the page, the notification panel was a fixed 380px pinned
24px from the right, and the login and filter inputs were wider than the
content column. One 640px block per app fixes those; every rule is inside the
query, so the desktop layout is untouched. Ten data tables that had no
horizontal scroller of their own got one, so a wide table scrolls itself
instead of scrolling the page.

`m181Live H7` and `m181DemoSpotcheck` both measure real `scrollWidth` overflow
at 390px across four surfaces. Every one reports 0px.

## 24. Transport and the error contract

CORS was `app.use(cors())` — every origin. It is now an allowlist from
`SCOUTBOX_ALLOWED_ORIGINS`; with nothing set, development keeps its permissive
behaviour and the capability report says so, rather than silently locking a
developer out of their own machine (§74).

Baseline response headers are set on every response: `nosniff`, `no-referrer`,
`X-Frame-Options: DENY`, `Cross-Origin-Resource-Policy: same-site` and a
`Permissions-Policy` refusing geolocation, microphone and payment. None of
these replaces an authorization check; they stop a browser doing something
helpful with our responses.

The body limit is stated (20 MB, because media still travels as data URLs on
the upload path) rather than left to a default. And the error contract:
everything used to arrive as `500 INTERNAL` with the raw message attached, so
an oversized body and a genuine crash were indistinguishable and the message
could carry internal detail. Known request faults now answer with their own
code — `413 REQUEST_TOO_LARGE`, `400 MALFORMED_JSON`, `415
UNSUPPORTED_ENCODING` — and anything genuinely unexpected stays a 500 whose
message is fixed text, with the detail in the log.

## 25. Operator honesty: `/capabilities` and boot assertions

ScoutBox is careful to be honest **inside** the product about what it cannot
do. None of that was visible to whoever deploys it: an operator could not
answer "is a real identity provider configured here?" without reading the
source.

`GET /capabilities` answers it, and reports **state only** — no keys,
hostnames or connection strings. It covers production computer vision,
distributed rate limiting, an authoritative identity provider, email
transport, object storage, the media signing secret and the test provider,
each with one sentence on what its absence means.

It is deliberately hard to inflate. `web_client` is `limited`, not
`configured`: it infers presence and active duration from the camera stream
and nothing more, and reporting that as production computer vision would be
exactly the capability inflation the rest of the product refuses. A test-only
provider counts as available only when the environment actually enables it.

Boot assertions refuse configuration that would be unsafe in production —
`BOX_CAM_TEST_PROVIDER=1`, a missing `SCOUTBOX_MEDIA_SECRET`, dev login — and
leave development untouched. Trust Score weights that do not total 100 are
fatal in **every** mode: a wrong score is not a development-only problem.

---

## Trust & Safety and M18 material (deferred, by design)

T&S has **no** default access to Second Look, Nobody Missed or Recruitment
Briefs, and M18.1 does not give it any. That default is correct: these are a
club's private recruitment decisions, and a blanket support role over them is
worse than none. `m181E2E §19b` asserts the admin key opens none of the three.

The shape a proper grant would take, when it is built as its own milestone:

- **Scoped** to one organisation and one record, never a role that sees all.
- **Reasoned** — the grant carries the case it was opened for.
- **Time-bound** with an expiry the grantee cannot extend.
- **Audited** on grant, on every read, and on expiry, visible to the
  organisation whose material was read.
- **Read-only.** T&S never edits a recruitment decision.

## Regression battery

Server: trust 23 · apiE2E 130 · connectedE2E 43 · m12 143 · m13 212 · m14 193 ·
m14.1 94 · m15 185 · m16 115 · m16.1 79 · m16.2 124 · m17 406 · m18 286 ·
**m18.1 195 (53% negative)**.

Browser: navConfig 155 · navLive 30 · uiSpotcheck · demoOffline · crosstab ·
liveIntegration · m12Live · m13Live · m14Live · m15Live 21 · m16Live 10 ·
m16.2Live 11 · m17Live 25 · m18Live 60 · **m18.1Live 37** · demo spotchecks for
M12, M13, M14, M16.2 (21), M17 (47), M18 and **M18.1**.

All green. Typechecks and production builds clean for club, grassroots, player
and admin.

## Test-harness notes

One `m18E2E` run in this session reported a boot failure and then passed eight
consecutive times with no code change in between. The 15-second boot wait was
tight on a loaded machine, so seven suites now wait up to 40 seconds. No
assertion was changed or removed.

`apiE2E` used a constant guardian email, so a second run against the same
database failed there and, had it got past that, would have read the *first*
matching verification code out of the outbox. The address is unique per run
now, and a duplicate signup is asserted to be refused (130 checks, was 129).
The suite is still fresh-database-only past that point, exactly as its own
header has always said.

## What M18.1 deliberately did not do

Explainable Matching · Dynamic Watchlists · AI recommendations · any new player
score · a new Trust Score policy · new Combine protocols · a Box Cam CV model ·
federation expansion · billing · analytics dashboards · new top-level
navigation. None of these appear in M18.1.
