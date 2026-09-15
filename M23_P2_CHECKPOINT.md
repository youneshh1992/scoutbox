# M23 P2 — Verified Recovery Checkpoint

The last verified recovery bundle was M22-era and predated every line of M23.
This is the replacement, taken at the frozen P2 correction tip.

---

## Bundle

| | |
|---|---|
| Path | `/home/user/scoutbox-m23-p2.bundle` |
| Source branch | `claude/desktop-project-migration-wyk3ec` |
| Source tip | `3e4c8a00844685f73c441203192cc58a9d09e2d3` |
| Commits ahead of origin | **153** |
| Size | **3,360,262 bytes** (3.3 MB) |
| SHA-256 | `409eea20fccf65e86518105e1c0ef994c6cfd9b5f7da79b51a27a46ee75807f7` |
| Contents | `--all` — every ref, including `main` and both origin remotes |

## `git bundle verify`

```
b2eca8e9993d34ab67a89d16e7823a093dacf303 refs/heads/main
c1758a2b17ea90aecd8f51f7cf5f79c3ef2fce6f refs/remotes/origin/claude/desktop-project-migration-wyk3ec
b2eca8e9993d34ab67a89d16e7823a093dacf303 refs/remotes/origin/main
3e4c8a00844685f73c441203192cc58a9d09e2d3 HEAD
The bundle records a complete history.
```

**PASS.** A complete history, not an incremental pack that needs a prerequisite
the recovering machine may not have.

## Fresh clone

Cloned into `/home/user/restore-check` — a genuinely separate directory, never
the working tree.

```
restored HEAD : 3e4c8a00844685f73c441203192cc58a9d09e2d3
source tip    : 3e4c8a00844685f73c441203192cc58a9d09e2d3
                HEAD MATCHES SOURCE TIP
```

## Tests run from the restored clone

Required:

| Suite | Result |
|---|---|
| `m23Persistence` | 67 checks, 0 failures |
| `m23BootContract` | 45 checks, 0 failures |
| `m23E2E` | 349 checks, 0 failures |
| `m17E2E` | 515 checks, 0 failures |
| `m18E2E` | 286 checks, 0 failures |
| `m20E2E` | 259 checks, 0 failures |
| `m22E2E` | 112 checks, 0 failures |

Optional high-value (both previously exposed harness or infrastructure issues):

| Suite | Result |
|---|---|
| `m182E2E` | 0 failures |
| `apiE2E` against the restored live server | **130 checks, 0 failures** |

Plus the remaining battery from the same clone — `m12E2E`, `m13E2E`, `m14E2E`,
`m141E2E`, `m15E2E`, `m16E2E`, `m161E2E`, `m162E2E`, `m181E2E`, `m19E2E`,
`m21E2E`, `connectedE2E` — all 0 failures.

## Restored server boot

```
{"ok":true,"uptimeS":5,"schemaVersion":2302}

schema      : version 2302, expected 2302, 12/12 migrations applied, upToDate
stores ok   : true
missing     : []
boot log    : schema 0 → 2302, twelve steps applied in order
              no STORE_MISSING, no INTEGRITY violation
```

Stopped cleanly afterwards. No test-owned process, demo host, Chromium
instance or port (4000, 4001, 4006, 4017, 4018, 4020, 4023, 4055, 4056, 8099,
8701, 8702, 8723) left listening.

One note on `apiE2E`: its "snapshot persisted" check reads
`<server-dir>/data/scoutbox.db` by construction, so it must be run against a
server using the **default** data directory. Pointed at a server with
`DATA_DIR` overridden it reports that one check as a failure — a harness
assumption about where to look, not a product defect. Run as designed, 130/130.

## Pre-bundle scans

**Secrets.** Zero matches for real credential shapes — AWS keys, `sk_live_`,
GitHub PATs, PEM private keys, Slack tokens. The only hardcoded strings that
match a generic `secret|password|token = "…"` pattern are self-describing test
fixtures, which existing policy permits:

| Where | Value |
|---|---|
| `scoutbox-club/src/m13demo.ts`, `scoutbox-grassroots/src/m13demo.ts` | `DEMO2SECRET2NOT2REAL2AAA`, labelled "Demo secret" in the payload |
| `scripts/apiE2E.mjs` | `wrong-password` (a deliberate failed-login case) |
| `scripts/connectedE2E.mjs` | `club-secret-1`, `eastport-secret-1` |
| `e2e/m182E2E` env | `m182-test-secret-value-not-real` |

No `.env` file exists anywhere outside `node_modules`; the three `.env.example`
templates contain a localhost URL and an empty flag.

**Temp and generated files.** No log, temp database, screenshot, video frame,
cache, credential file or build artefact is tracked. No `dist/` or
`dist-live*/` directory is tracked. The working tree was clean at bundle time,
with nothing untracked.

**M22 artefact determinism.** `m22CvEval` and `m22Holdout` were re-run and the
outputs compared field by field against the committed versions:

```
evaluation.json : 1 line differs — "generatedAt"
holdout.json    : 2 lines differ — "generatedAt" (x2)
```

**Zero non-timestamp change.** Every measured figure is identical. The
timestamp-only churn was reverted rather than committed.

## Durability limitation — stated precisely

This bundle is a **verified recovery artefact**, and it is **not an off-machine
backup**.

It lives at `/home/user/scoutbox-m23-p2.bundle` inside an ephemeral container
filesystem. The container is reclaimed after a period of inactivity or when the
session ends, and the bundle goes with it. What has been proven is that *this
file*, right now, restores to a clone whose HEAD equals the source tip and
whose full test battery passes — not that the work survives the machine.

The only durable protection for 153 unpushed commits is a push to a remote,
which this task explicitly does not authorise. Until then the bundle protects
against a working-tree accident, not against losing the container.
