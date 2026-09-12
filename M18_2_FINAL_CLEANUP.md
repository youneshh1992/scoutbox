# M18.2 — Final Pre-M19 Cleanup

M18.2 adds no recruitment concept. It removes ambiguity: an event that could
reach a client without anyone having decided who may see it, a notification
nobody could mute, a conflict told two different ways, an ordering nobody had
declared, a schema nobody had versioned, an age computed in whatever time zone
the host happened to be in. Everything here is a foundation for M19
(Explainable Matching, Dynamic Watchlists), none of it is M19.

Companion documents: `M18_2_MATRIX.md` (27 findings, each with its test and
its remaining limitation), `M18_2_SORTING_AUDIT.md` (every ordered surface).

## 1. What M18.2 was for

"Fewer ambiguous behaviors, fewer hidden assumptions, fewer production
surprises." Each section below names the assumption that was hidden, what now
makes it explicit, and the test that would fail if it went back into hiding.

## 2. The canonical event registry

`scoutbox-server/m182/eventRegistry.mjs` is the one table of every event the
server broadcasts — 18 names — each with `domain`, `sourceSystem`, `audience`,
`privacyClass`, a `payload` allowlist, `dedupeStrategy`, `replayPolicy`,
`notificationEligible` and `analyticsEligible`. The M18.1 audience table
(`m181/eventAudience.mjs`) is now a *view* over the registry, not a second
table that could disagree with it. An unregistered name still fails closed to
`org_private` (the M18.1 rule), and `EMITTED_EVENTS` in `server.mjs` is
asserted at boot against the registry: development throws, production logs.

`m182E2E §1` greps every `broadcast('…')` call site in the server tree and
fails if the list and the registry disagree in either direction — a new event
cannot be added without a privacy decision being written down.

## 3. Payload minimisation

`broadcast()` passes every payload through `minimizePayload()`: keys not on the
event's allowlist do not ship. Development throws on a dropped key (a new key
is a new privacy decision); production strips and counts
(`events.payloadDrops` on `/capabilities`). Two payloads were reduced by this:
`recruitment_room_archived` now carries `{orgId, roomId}` and nothing else,
and `recruitment_room_reopened_from_second_look` — unregistered since M18 —
is registered with `{orgId, roomId, itemId}`. `m182E2E §3` asserts no
allowlist admits a date of birth, email, note, body, address, password or
token; `§29` reads the archived event off the real event stream and checks
the wire.

## 4. One fingerprint rule

`eventFingerprint(event, payload)` is the shared dedupe contract: the M18
`type:sourceSystem:sourceId` rule for durable facts, `event:subject` for
coalescing pings, none for the rest. Key order and extra keys do not change
it; an unregistered event has no fingerprint, so nothing can dedupe it into
silence (`§4`).

## 5. Terminology

The sweep of the mandated terms found one user-facing hit:
`rm.trustAtDecision` said "Trust" where the product means "Trust Score"; fixed
in EN and FR. No copy calls anyone a "verified player" (evidence is verified,
people are not) and no copy names a player score, rating or rank (`§5`).
Comments that use the older words as English are left as comments.

## 6. Ordering: declared, deterministic, not a ranking

Every Discover sort now ends on the player id, so two reads return the same
order whatever the snapshot store loaded first. The ordering is declared on
the wire (`X-ScoutBox-Ordering: academy_plus,profile_completeness,player_id`
for Pro; `first_team_seeker,distance,profile_completeness,player_id` for
Grassroots) and stated to the person on the screen, with the sentence saying
what completeness is *not* — ability, or the Trust Score. The ordering itself
was deliberately kept (the mandate's option A); replacing it is an M19
decision. The full inventory of 22 server and 3 client surfaces is
`M18_2_SORTING_AUDIT.md`. `§7`, `§27`, `J9`.

## 7. Notification preferences

`m182/notificationPrefs.mjs`: twelve categories, every one of the server's
notification types classified (`§8` greps every literal `notify()` type in the
source and fails on an unclassified one). Mentions and assignments share the
`recruitment_room` type with ordinary Room changes and are recognised from the
server's own wording, never from user text (`§8` proves a message containing
"mentioned you" is not a mention).

Enforcement happens inside `notify()` before a row is created, so a muted
category produces nothing — not a hidden row, nothing (`§24`). Defaults are
conservative without muting an obligation: `discovery_nudges` (badges, level
ups, calibration prompts) is off; outcomes, signings, report deadlines, trial
days and saved-search alerts the scout asked for are on. `security_account` is
mandatory and a stored `false` for it is ignored (`§9`). An unknown type is
delivered and counted on `/capabilities` — a missing notification is the worse
failure. Email is an *intent* recorded for when a transport exists; the
preference view says "local outbox" and "nothing is sent outside ScoutBox".
Routes: `GET/PUT /{org,player,guardian}/notification-preferences`. `J4` drives
the panel.

Every notification row now carries `groupKey` (`type:refId`) and `category`,
so any reader can fold repeated updates about one object; the bell keeps the
M18.1 repeat-collapse and does not yet fold *different* updates into one row
(matrix #10, data done, UI deferred).

## 8. One conflict experience

`conflict.tsx`: `conflictOf(error)` reads a 409 whose code ends in
`VERSION_CONFLICT` and nothing else; `ConflictNotice` renders it — human
sentence first, the colleague's *name* (the 409 now carries `updatedBy` as a
display name and `updatedAt`; never a user id), the machine code kept as data,
`role="alert"`. Rooms (status, decisions), Briefs (edits, status) all use it.
"Reload latest" re-reads; "Keep my changes" is offered only by a form that
can hold a draft. `J1` found that "Reload latest" on a Brief closed the editor
but left the pre-conflict detail on screen; closing the editor now re-reads.
`J2` proves the Room conflict is the same notice, word for word.

## 9. Unsaved-change protection

`dirtyGuard.ts`: a form registers a function, not a flag, so "dirty" is
whatever the form says at the moment someone tries to leave. Sidebar, Room and
Brief navigation ask `confirmLeave()`; close and reload get `beforeunload`; a
hash change asks `guardHashChange()`.

The first implementation put the hash decision in a second `hashchange`
listener. `J3` showed that React can render synchronously inside the *first*
listener, unmounting the dirty form before the second one asks it anything —
the guard saw zero registered forms and let a dirty form go. The decision now
lives in the app's own handler, before any state changes, and programmatic
navigation keeps the remembered hash in step. A clean form never prompts
(`J3` asserts it, because a guard that fires on a clean form trains people to
click through).

## 10. Canonical provenance

`provenance.ts` is the one place a provenance type becomes words: the nine
server values plus `combine_verified` and `simulated_demo`, each with a label,
a tone, a text glyph (colour is never the only signal) and the server's
one-line explanation where it sends one. An unknown type is "Source
unavailable — nobody is credited with confirming it"; it is never guessed as
"Player-provided", which is how Box Cam evidence was once mislabelled. The
Passport screen's private tables are gone; club and grassroots carry
byte-identical modules (`§17`).

## 11. The organisation audit log

`GET /org/audit` — leads and directors only; a scout gets 403, a player or
anonymous caller 401, another organisation's lead sees none of it. It is a
read-only projection over Room history, Brief history and three ledger rows
(staff removed, signing, released). An entry says what happened and who did
it; it says *that* a note was written (`hadNote`) and never the note, the
comment or the decision text (`§25` writes a note with a marker string and
asserts the marker is absent). Cursor-paged, at most 50, newest first, stable
between reads. `J5` reads it in the browser; `J8` shows the scout's 403 as a
permission message without ending the session.

## 12. Destructive actions

`confirmAction.ts` classifies every destructive action — reversible, archive,
tombstone, irreversible — and the class decides both whether to ask and what
to say. Consequence copy, never "are you sure" (`§16` asserts it per action in
EN and FR). Reversible actions (pause a brief, dismiss a Second Look item) do
not ask. The browser's `confirm()` is used on purpose: modal, keyboard-
operable, announced, and impossible to cover with a toast. The saved-search
controls became real buttons so they are keyboard-operable. `J10` declines an
archive and proves nothing changed.

## 13. Latency and failure simulation

`m182/faults.mjs`: `SCOUTBOX_FAULTS='kind:path[:arg];…'` or `POST /__faults`
in development — delay, unavailable (503), timeout (504), retryable-N (fails N
times, then works), fatal (500, not retryable). Rules match one path pattern
and nothing else (`§26` proves an unrelated route is unaffected). In
production the layer is disabled, loads no rules even if the variable is set,
mounts no control route, and a production boot with `SCOUTBOX_FAULTS` set is
a fatal configuration problem (`§12`, `§43` boots a real production process
and watches it exit). `J6` and `J7` show what a slow and a failed source look
like to a person: loading then content, or an announced error with "Try again"
only when retrying can help.

## 14. The HTTP error contract

`m182/httpContract.mjs` adds three headers so no body had to change shape:
`Retry-After` on every 429 from the named policy's window, `X-ScoutBox-Retry:
retryable | not-retryable` on every error (429/502/503/504 retryable; 401,
403, 404, 409 and validation not), `X-ScoutBox-Schema` on every response. It
is mounted *before* the body parser so a malformed-body 400 carries the same
headers (`§21`). `httpState.ts` on the client maps 401/403/404/409/413/429/5xx
and offline to one shape, with retry offered only when it can help. Only a
401 ends the session now; a 403 is an answer about one request (`J8`, matrix
#17). Error responses carry `X-Request-Id`, and a simulated failure carries
the same id in its body (`§21`, `§26`).

## 15. Schema version and migrations

`m182/migrations.mjs`: `SCHEMA_VERSION = 1820`, five ordered idempotent steps
recorded in `db.schema.migrations`, run after the snapshot loads and before
any save; a throwing step aborts boot with the disk untouched. What used to
be `db.x ??= []` in fourteen files is one step. `/healthz` reports the version,
`/capabilities` reports `upToDate`, `migrationsApplied` and the expected
version; every response carries it as a header. `§10` runs the registry twice
and on a broken snapshot; `§41` restarts a real server and sees five applied,
not ten; `§42` rewrites the saved snapshot to a pre-M18.2 shape (no schema
record, Rooms and Briefs without `rev`, notifications without `repeatCount`),
boots, and reads everything back upgraded.

Honest limitations: there is no down-migration (the snapshot store has no
concept of one), and no rollback of an in-memory mutation when a later step
fails — the process exits without saving, which is the same outcome. The
store upserts collections and never deletes one; a "removed" collection is
expressed by its pre-M18.2 value.

## 16. Boot-time integrity

`m182/integrity.mjs` reads the loaded snapshot once: one *open* Room per
organisation and player (a closed history may repeat), unique case, brief,
player and organisation ids, one Second Look item per (org, room), no
duplicated change fingerprint inside an item, no Room pointing at a missing
organisation or player, a positive integer `rev` on every rev-guarded record.
Violations are logged as codes and ids — never a name — and counted on
`/capabilities`. Nothing is repaired: a silent repair chooses which of two
conflicting records wins, and that is a person's decision. The process still
starts (`§11`, `§20`, `§28`, `§41–§42`).

## 17. Dates: UTC calendar days

`ageOn` uses UTC getters throughout, so a person is 18 from the first UTC
instant of their birthday in every time zone the server runs in; a leap-day
birth is 17 on 28 February and 18 on 1 March; a Korean 18-year-old is not an
adult and a British one is (`§13`). A Recruitment Brief window is inclusive
calendar days at both ends, compared as UTC day strings, extracted to
`briefIsLiveOn()` so the boundaries — first day, day before, last day, day
after, a window across the DST change — are tested without a clock (`§14`).
Second Look: the 30-day cooldown ends at exactly 30 days and the same evidence
never returns; an item is still open at exactly 120 days and expired one
millisecond later (`§15`). `ageOn('garbage')` is `NaN`, never 0, and such a
person is not an adult by accident.

Known limitation, unchanged: push quiet hours and the minors' school-hours
mute (`pushDeferred`) are evaluated in server-local time. They gate a push
transport that does not exist in this build; documented, not rewritten.

## 18. Read paths and the index decision (matrix #18)

The store is a snapshot in memory; there are no SQL indexes to add. The one
hot scan, `findPlayer`, was measured (`m182Perf`): ~0.1 µs at the seeded
size, ~1.4 µs at 300 players, ~14 µs at 3 000. An id index becomes worth its
invalidation risk (every mutation path must keep it fresh) only at thousands
of players. Not added; the threshold is recorded here. The audit projection is
recomputed per read and is linear in history size — fine to hundreds of rows;
a materialised index is the fix if organisations reach tens of thousands.

## 19. Verification

**New suites.** `scripts/m182E2E.mjs` — 313 checks, 159 negative (51%),
three boots (clean, restart, pre-M18.2 upgrade) plus a production boot that
refuses simulated faults. `e2e/m182Live.test.mjs` — 37 checks, J1–J10, real
browser. `scripts/m182Perf.mjs` — primitive costs, boot work by snapshot
size, the index decision, HTTP medians. `e2e/m182DemoSpotcheck.test.mjs` —
the shipped bundles.

**Server battery (all green).** trust 23 · apiE2E 130 · connectedE2E 43 ·
m12 143 · m13 212 · m14 193 · m14.1 94 · m15 185 · m16 115 · m16.1 79 ·
m16.2 124 · m17 406 · m18 286 · m18.1 195 · **m18.2 313**.

**Browser battery (all green).** navConfig 163 · navLive · uiSpotcheck ·
demoOffline · crosstab · liveIntegration · m12Live · m13Live · m14Live L1–L7 ·
m15Live 21 · m16Live 10 · m16.2Live 11 · m17Live 25 · m18Live 60 · m18.1Live
37 · **m18.2Live 37** · demo spotchecks for M12, M13, M14, M16.2 (21), M17
(47), M18, M18.1 and **M18.2** · staleSessionProbe 14 · headless runtime load
of every bundle with zero page errors.

Typechecks and production builds clean for club, grassroots, player and admin.
EN/FR parity: club 616/616, grassroots 618/618; no screen asks for a key that
does not exist.

## 20. What M18.2 deliberately did not do

Explainable Matching · Dynamic Watchlists · AI recommendations · any player
ranking or match score · a new Trust policy · new Combine protocols · Box Cam
computer vision · billing · federation expansion · a director analytics
dashboard · a new global sidebar item · a new Discover ordering · a
`findPlayer` index · a bell that folds different updates into one row · a
push transport (so quiet hours stay documented, not rewritten).

## Bugs found and fixed during M18.2 (reproduce → failing test → fix)

| Found by | What | Fix | Test kept |
|---|---|---|---|
| J1 | "Reload latest" on a Brief conflict closed the editor but left the pre-conflict title on screen | Closing the editor re-reads the brief | `m182Live J1` |
| J3 | The window-level hash watcher ran after React had unmounted the dirty form; a dirty form could be left silently | Decision moved into the app's hashchange handler (`guardHashChange`), before any state change | `m182Live J3`, `m182E2E §18` |
| J3 | `#/recruitment/rooms` — the parent of a deep link the app itself produces — resolved to nothing (Home) | `screenFromHash` resolves the parent of Room and Brief deep links | `navConfig` (+4) |
| §21 | A malformed-body 400 carried no retry/schema headers (contract middleware ran after the body parser) | Middleware order | `m182E2E §21` |
| §23 | A 409 named no one — the notice could only say "someone" | `guardRev` adds `updatedBy` (display name) and `updatedAt` | `m182E2E §23`, `J1` |
| preflight | Session restore logged out on 403 | 401 only | `m182Live J8` |
| preflight | `ageOn` mixed local and UTC getters | UTC throughout | `m182E2E §13` |

## Test-harness notes

`m18E2E`'s "third player" section assumed a fixed Discover order; after the
deterministic tie-break it re-reads the visible list and fails with the
server's answer if a Room cannot be created. No assertion was removed or
weakened. `apiE2E` still expects a server on :4000 using the default data
directory; it was run that way. Four earlier suites were adapted to deliberate
M18.2 changes, none weakened: `m17Live` and `m18Live` accept the archive
confirmation dialog; `m181Live H2` accepts the shared conflict notice's
wording beside the server's; `m17DemoSpotcheck` accepts "Trust Score at
decision". `m181DemoSpotcheck` and `m15Live` were NOT changed — they caught
two copy regressions (Discover naming the Trust Score without "evidence
confidence"; provenance labels drifting from the M15 wording) and the copy
was corrected instead. `m181Live`'s `RM` constant pointed at a hash
that resolved nowhere; its H4 passed on the Briefs page's own table. That
hash now resolves (the nav fix above), so H4 exercises the Rooms table as
intended; the constant is left as it was.
