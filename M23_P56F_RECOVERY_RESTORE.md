# M23 P5.6F — recovery and restore (reconstructed)

> **P5.6F was reconstructed from the frozen `b8556c1` base after an ephemeral
> container loss. The reconstructed implementation is evidenced independently;
> original lost P5.6F hashes are historical references only.**

This document exists because the thing it describes already failed once.

---

## 1. What happened, plainly

The original P5.6F was completed: four commits, ten documents, a verified
recovery bundle, a proven restore. None of it was pushed, because the milestone
mandate forbade pushing until a separate audit authorised it. The bundle lived in
the container's scratchpad.

The container was then rebuilt. The working copy came back as a fresh clone at
`b2eca8e` with one tracked file. The four commits (`c602f61`, `bb3b53f`,
`75625a2`, `46f5f76`) were gone from the object store, no dangling objects
remained, the scratchpad was empty, and the bundle was gone with it. Origin still
had `b8556c1`, so everything through P5.6E survived; only P5.6F was lost.

**The lesson is not "make a bundle".** A bundle was made. The lesson is that a
backup which lives only inside the thing it is backing up is not a backup, and
that holding every commit unpushed until the end of a milestone converts a routine
container reclaim into the loss of the whole milestone.

## 2. What changed in the discipline

Per §27, a bundle is now created **immediately after the first meaningful
checkpoint** and refreshed after each one, rather than once at the end:

| Checkpoint | Tip | Bundle |
| --- | --- | --- |
| R1 product hardening | `b92e5e9` | `scoutbox-p56f-r1-b92e5e9.bundle` |
| R2 A3 / Grassroots | `0b73965` | `scoutbox-p56f-r2-0b73965.bundle` |
| R3 viewports / contention | `c55b5aa` | `scoutbox-p56f-r3-c55b5aa.bundle` |
| R4 documents / closure | see the final report | reported there |

Each one's SHA256 is reported in the message that announces the checkpoint, so it
is recorded outside the container as well as inside it.

**This is still not enough on its own**, and the document should say so: every one
of those bundles lives in the same ephemeral scratchpad as the one that was lost.
The only durable backup is a push, and a push needs authorization. So the standing
recommendation is: authorise an intermediate backup push at the first checkpoint,
not the last.

## 3. What has to survive

| Thing | Where it lives | Recoverable? |
| --- | --- | --- |
| P5.6A–E source and history | `origin/…/wyk3ec` at `b8556c1` | yes — pushed |
| the P5.6F commits | this container, plus the bundles | **only through a bundle or a push** |
| the SQLite snapshot store | `scoutbox-server/data/` — gitignored | no, deliberately: reproduced by a cold boot |
| build output (`dist-*`) | gitignored | no, deliberately: reproduced by a build |
| `node_modules` | gitignored | no — `npm install` |

Only the first two matter. §26's fresh-clone run proves the rest is derived
correctly.

## 4. The bundle, and what it does not contain

Built incrementally on the tip origin already has:

```
git bundle create scoutbox-p56f-<tip>.bundle b8556c1..claude/desktop-project-migration-wyk3ec
```

Incremental on purpose: `git bundle verify` then refuses to apply it to a
repository that lacks `b8556c1`, which is the check you want. A self-contained
bundle would apply anywhere, including to the wrong history.

**No secrets.** The only credential-shaped tracked files are five
`.env.example` templates, and every value in them is blank — `MEDIA_SECRET=`,
`ADMIN_KEY=`, `SENDGRID_API_KEY=`, `STRIPE_SECRET_KEY=` and the rest are present
as documented names with no values. **No database, no uploads, no
`node_modules`, no build output** — each confirmed ignored with
`git check-ignore` rather than assumed.

## 5. The restore procedure

```bash
git clone https://github.com/youneshh1992/scoutbox.git
cd scoutbox
git checkout claude/desktop-project-migration-wyk3ec        # lands on b8556c1

git bundle verify /path/to/scoutbox-p56f-<tip>.bundle
git fetch /path/to/scoutbox-p56f-<tip>.bundle \
    claude/desktop-project-migration-wyk3ec:claude/desktop-project-migration-wyk3ec
git checkout claude/desktop-project-migration-wyk3ec
git log --oneline b8556c1..HEAD

cd scoutbox-server && npm install
PORT=4000 DATA_DIR=./data node server.mjs      # a cold boot migrates to 2307
```

## 6. The proof — executed, not described

| Step | Result |
| --- | --- |
| `git bundle verify` | *"is okay"*; contains the branch ref, requires `b8556c1` |
| clone a target and `reset --hard b8556c1` | target at `b8556c1` — the origin state, simulated without the network |
| `git fetch <bundle> <branch>:restored` | target became the bundle tip |
| `git log --oneline b8556c1..HEAD` | the reconstruction commits, in order |
| every tracked file compared with `cmp` | **no tracked file differs** from the source working copy |

## 7. What the restore proof does not cover

The target simulated origin by resetting a local clone to `b8556c1` rather than
cloning from GitHub. That substitution is deliberate — the bundle depends on the
base commit's identity, and a local clone reset to that commit is equivalent for
this purpose. What it cannot catch is a GitHub-side problem with `b8556c1`
itself; that commit's presence on origin is verified separately by `git fetch`
and by `git rev-parse origin/…` reporting `b8556c1` at the start of this
milestone.

## 8. Recovery of the runtime, not just the source

A recovered repository is worth nothing if it cannot be brought up. From a clone
with no `node_modules`, no database and no build output (§26):

- 0 carried `node_modules`, 0 carried `dist` directories, 0 carried `.db` files —
  counted, not assumed;
- `npm install` clean for the server and the e2e harness;
- a cold `DATA_DIR` → `scoutbox.db` created and migrated to **2307**, read from
  the `X-ScoutBox-Schema` response header rather than a log line;
- the server answered `/health`, then **released its port**, measured from
  `/proc/net/tcp`;
- five typechecks clean; four Vite builds and the player's Expo export clean;
- the Agent hardening suite: **247 checks**;
- a real live Agent journey in Chromium: **48 checks**.

So: **source from the bundle, runtime from the repository, data from a
migration.** All three executed.
