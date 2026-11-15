# Pilot continuation: a hard slice

The first pilot ported the staff slice, which the `platform/staff` battery checks. It showed that the platform
layer works and that a battery can be passed unchanged. It did not test the parts that would justify the move:
rules over joined data, acts that write several tables, the code generator, and batteries that reach into the
TypeScript server. This step tests those, and ends in a go or no-go.

## Slice

**Primary: `platform/safeguarding`** (401 lines, no imports from server internals). It needs:

- player sign-up and sessions;
- org views of players, with the visibility rules (under-18 gating, the grassroots radius) and the block check;
- shortlists, notes and the Discovery Ledger, paged by cursor and scoped to its owner;
- player blocks and reports, the grooming-moderation hit and its urgent escalation;
- admin triage and resolution: suspension blocks, frozen requests, the organisation's suspension and the
  reporter's notice;
- the guardian's log and inbox, and notifications.

This is the safeguarding core, so a port of it has the most to prove.

**Second: `platform/playersAndGuardians`** (348 lines, no internal imports). It shares the player and guardian
identity tables, so it should come cheaply once the primary is done. Use it to check the marginal pace.

**Battery untangling: `platform/sessionsAndPorts`.** It imports `scripts/dataLayerFixture.mjs`, as 24
batteries do, to write a database through the TypeScript repositories before booting. Don't port its routes.
Instead, replace that one dependency with a language-neutral fixture writer: plain SQL through `node:sqlite`
against the migrated schema. Then confirm the battery still passes on the TypeScript server unchanged. This
times the untangling cost that every coupled battery will carry.

## Steps

1. **Code generator first.** Bring the spike's schema-driven generator (`~/Code/sqlite_spike/dev/codegen.gleam`)
   into `scoutbox-server/dev/`. It should produce row types, decoders, column lists and inserts, plus one
   shared enum per vocabulary (declare the shared ones once; don't generate one per table). Regenerate the
   existing slice's tables with it and delete the hand-written decoders it replaces. Snapshot-test it with
   birdie.
2. **Distance rules.** Port `haversine_km` and `distance_tenths` to SQLite's built-in math functions. Prove they
   agree with the TypeScript rule over random points, at the boundaries of the visibility radius included.
3. **Port the primary slice** against its battery, bottom up: tables, then repositories, then acts, then routes.
   Mark anything that depends on an unported domain `Not ported yet:`.
4. **Port the second battery's remaining routes.**
5. **Untangle `sessionsAndPorts`** on the TypeScript side, as above.
6. **Measure, then decide** (below). Record the results in
   `../scoutbox/.claude/plans/gleam-migration-evaluation.md`.

## Measure

- **Time:** working sessions spent on each of steps 1–5, kept separately.
- **Code:** generated lines versus hand-written lines, and hand-written lines per route compared with the staff
  slice.
- **Batteries:** both pass with only `e2e/sync.mjs`'s mechanical rewrites. List any assertion that needed more.
- **Untangling:** the time for `sessionsAndPorts`, and whether the SQL fixture writer is reusable by the other
  23 batteries as it stands.
- **Performance:** p50 on the org player view and the report-resolution act with the perf seed, under 5 ms; also
  under concurrent clients, where the BEAM should pull ahead.
- **Libraries:** anything missing, broken or vendored.

## Decide

**Go**, and plan the full port domain by domain behind the batteries, if all of these hold:

- Both batteries pass.
- The distance rules agree.
- Hand-written code per route has fallen clearly below the staff slice's, now that the generator is in.
- The second battery took markedly less time than the first.
- The SQL fixture writer generalises.

Extrapolate the time to all 849 routes, plus untangling the coupled batteries, and put that figure to the
Founder as the length of the freeze.

**No-go** if the slice stalls on the ecosystem, if the generator doesn't cut the boilerplate, or if the freeze
it implies doesn't fit the year. The TypeScript path in the evaluation remains. The SQL fixture writer from
step 5 is worth keeping either way.

## Out of scope

Live events (SSE), uploads, outbound providers, observability, password hashing, deployment. Each needs its own
short check before a go becomes a full plan.
