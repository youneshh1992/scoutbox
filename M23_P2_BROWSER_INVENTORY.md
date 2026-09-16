# M23 P2 — Browser / Live / Demo Suite Inventory

> Every browser-driven suite in the repository, discovered mechanically,
> classified, and run from clean port state.

Discovery was `ls e2e/*.test.mjs` plus a grep over each file for `chromium`,
`spawn(`, `vite build`, `demoHost` and its port literals — not a list carried
forward from a previous milestone. Two supporting files (`staleSessionProbe.mjs`,
`connCheck.tmp.mjs`) are probes, not suites, and are classified below rather
than silently dropped.

---

## 1. Result (§18)

```
browser/live suites discovered : 35   (33 suites + 2 non-suite probes)
applicable                     : 33
run                            : 33
passed                         : 33
failed                         : 0
skipped as inapplicable        : 2    (both are probes, not suites — reasons below)
```

Process/port state after the battery:

```
no surviving node/chromium/vite
zero listeners on all known test ports
```

**Not one suite was inapplicable on grounds of being superseded.** Every
milestone from M12 to M23 still has a live suite that runs and passes against
the current tip.

## 2. Host ownership (§16)

Every Live suite owns its host. There is no shared runner, no
`beforeAll` that starts a server for somebody else, and no suite that inherits
one by accident:

| Pattern | Suites | How the host arrives |
|---|---|---|
| **spawns its own backend + serves its own client build** | all 17 `*Live` + `liveIntegration` | `spawn('node', ['server.mjs'])` with its own `PORT` and a `mkdtemp` `DATA_DIR`, plus `http.createServer` for the static bundle it just built |
| **owns a demo host** | 10 `*DemoSpotcheck`, `crosstab`, `demoOffline`, `uiSpotcheck`, `demoHostOrdering` | `demoHost.mjs`, started by the suite |
| **no host at all** | `navConfig` | pure config assertions, no browser, no server |

Each backend gets a **fresh temporary data directory**, so no suite can seed
another's database (§24).

Two ports are shared *sequentially* and by different suites — 4018 by
`m18Live` and `m182Live`, 4019 by `m181Live` and `m19Live`. That is safe
because the battery is sequential and each suite frees its port on exit; it
would not be safe under parallel execution, and the battery does not run in
parallel.

## 3. A host that cannot start must FAIL (§17)

Searched for the forbidden shape — catch `EADDRINUSE`, skip some checks, report
success. **It does not exist anywhere.** The only `catch {}` blocks in the live
suites are health-poll retries inside a bounded `for` loop, which fall through
to a real request that then fails.

Verified empirically rather than by reading:

```
$ node -e "http.createServer().listen(8723)" &     # squat m23Live's static port
$ node m23Live.test.mjs
  ... Error: listen EADDRINUSE :::8723
  EXIT=1
```

Exit 1, loud, zero checks reported as passed.

## 4. The inventory

`owns host` — the suite starts and stops its own server(s).
`builds clients` — the suite runs a real `vite build` from source; nothing is
copied from a working tree.

### Live suites (real browser, real backend)

| suite | milestone | applicable | owns host | builds clients | ports | checks | status |
|---|---|:---:|:---:|:---:|---|---:|---|
| `liveIntegration` | M11 | yes | yes | yes | 4001, 8281-8283 | — | **pass** |
| `navLive` | M15-Nav | yes | yes | yes | 4006, 8395-8397 | 30 | **pass** |
| `m12Live` | M12 | yes | yes | yes | 4001, 8281-8282 | 8 | **pass** |
| `m13Live` | M13 | yes | yes | yes | 4002, 8291-8293 | — | **pass** |
| `m14Live` | M14 | yes | yes | yes | 4003, 8391-8394 | — | **pass** |
| `m15Live` | M15 | yes | yes | yes | 4007, 8491-8494 | 21 | **pass** |
| `m16Live` | M16 | yes | yes | yes | 4008, 8591-8594 | 10 | **pass** |
| `m162Live` | M16.2 | yes | yes | yes | 4009, 8601-8602 | 11 | **pass** |
| `m17Live` | M17 | yes | yes | yes | 4017, 8701-8702 | 25 | **pass** |
| `m18Live` | M18 | yes | yes | yes | 4018, 8802-8803 | 60 | **pass** |
| `m181Live` | M18.1 | yes | yes | yes | 4019, 8812 | 37 | **pass** |
| `m182Live` | M18.2 | yes | yes | yes | 4018, 8813 | 37 | **pass** |
| `m19Live` | M19 | yes | yes | yes | 4019, 8814 | 17 | **pass** |
| `m20Live` | M20 | yes | yes | yes | 4020, 8815 | 59 | **pass** |
| `m21Live` | M21 | yes | yes | yes | 4021, 8821-8822 | 68 | **pass** |
| `m22Live` | M22 | yes | yes | no (fixture) | 4122, 8921 | 41 | **pass** |
| `m23Live` | **M23** | yes | yes | yes | 4023, 8723 | **39** | **pass** |

`m12Live` completes in about four seconds. That was checked rather than
assumed: it runs eight real assertions against a real backend through a real
browser and exits 0. It is a small suite, not a skipping one.

### Demo spotchecks and offline checks (browser against built demo bundles)

| suite | milestone | applicable | owns host | builds clients | checks | status |
|---|---|:---:|:---:|:---:|---:|---|
| `m12DemoSpotcheck` | M12 | yes | demoHost | no | — | **pass** |
| `m13DemoSpotcheck` | M13 | yes | demoHost | no | — | **pass** |
| `m14DemoSpotcheck` | M14 | yes | demoHost | no | — | **pass** |
| `m162DemoSpotcheck` | M16.2 | yes | demoHost | no | 21 | **pass** |
| `m17DemoSpotcheck` | M17 | yes | demoHost | no | 47 | **pass** |
| `m18DemoSpotcheck` | M18 | yes | demoHost | yes | — | **pass** |
| `m181DemoSpotcheck` | M18.1 | yes | demoHost | yes | — | **pass** |
| `m182DemoSpotcheck` | M18.2 | yes | demoHost | no | — | **pass** |
| `m19DemoSpotcheck` | M19 | yes | demoHost | no | — | **pass** |
| `m20DemoSpotcheck` | M20 | yes | demoHost | no | — | **pass** |
| `m21DemoSpotcheck` | M21 | yes | demoHost | no | — | **pass** |
| `uiSpotcheck` | cross-cutting | yes | demoHost | no | — | **pass** |
| `crosstab` | M11 | yes | demoHost | yes | — | **pass** |
| `demoOffline` | M11 | yes | demoHost | no | — | **pass** |
| `demoHostOrdering` | harness | yes | demoHost | no | 15 | **pass** |
| `navConfig` | M15-Nav | yes | none | no | 36 | **pass** |

There is no M15 or M16 demo spotcheck, and no M22 or M23 one. That is the
repository as it stands, not an omission from this battery — M23 P2 ships no
client surface to spotcheck, which is why its coverage is a Live suite.

### Discovered, and NOT suites (§18 — the two "skipped", with reasons)

| file | what it is | why it is not run as a suite |
|---|---|---|
| `staleSessionProbe.mjs` | a diagnostic probe. Injects a stale session into `localStorage` on port 8137 and reports what the client does with it. | It has no pass/fail contract and no exit code discipline — it prints observations for a human. Running it in a battery would produce a green tick that asserts nothing. |
| `connCheck.tmp.mjs` | a scratch connectivity check, named `.tmp` by its author. | Not a `*.test.mjs`, not referenced by anything, and explicitly temporary. |

Supporting modules that are correctly not suites: `demoHost.mjs`, `serve.mjs`,
`inline.mjs`, `buildDemos.mjs`, `buildConnectedDemo.mjs`, `m22Fixture.mjs`.

## 5. What this battery found

**F3 — five lifecycle states had no client label, in either language.**

`statusLabel` falls back to `code.replace(/_/g, ' ')`, so `on_hold` rendered as
"on hold" and `offer_accepted` as "offer accepted". The server deliberately
labels that state **"Accepted in ScoutBox"**, because a signing is a separate
legal event and "offer accepted" overstates what happened.

The existing `m23Live` L7 check could not catch it: it greps the page for
`\bon_hold\b`, and the fallback produces no underscore, so a missing label
passed exactly as well as a real one. The check was written to catch a raw
enum and it does — a missing label is a different defect.

Fixed in `scoutbox-club` and `scoutbox-grassroots`, EN and FR, using the
server's own wording. `m23Live` now carries **L7b/L7c**, stated positively and
over the whole of `ROOM_STATUSES` imported from the server, so a state added
later cannot arrive unlabelled: 37 → **39 checks**.
