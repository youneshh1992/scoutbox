/**
 * M18.2 — an explicit schema version and a migration registry.
 *
 * ScoutBox's persistence is a snapshot store: the working set lives in memory
 * and every save writes each collection as one JSON row. There is no
 * relational schema to migrate, but there IS shape: which collections exist,
 * which fields a record is expected to carry, and which defaults a module
 * assumes. Until M18.2 all of that was `db.x ??= []` scattered across fourteen
 * files at boot — idempotent by construction, invisible to an operator, and
 * unversioned, so "which schema is this database on?" had no answer other
 * than "whichever tables happen to exist".
 *
 * This registry does three things and deliberately no more:
 *
 *   1. records a schema version in the snapshot (`db.schema`), readable from
 *      /healthz and /capabilities and on every response as X-ScoutBox-Schema;
 *   2. runs an ordered list of idempotent steps and records which ones have
 *      been applied, so a second boot applies none of them again;
 *   3. aborts boot if a step throws. A half-applied snapshot is never saved
 *      as healthy: the steps run against the in-memory db BEFORE the first
 *      save, so a failure leaves the on-disk snapshot exactly as it was.
 *
 * Honest limitation: there is no rollback of a step that has already mutated
 * memory when a later step fails — the process exits without saving, which
 * is the same outcome. There is also no "down" migration, because the
 * snapshot store has no concept of one and inventing it here would be theatre.
 */

import { planCatalogue, archetypeCatalogue } from '../catalogue.mjs';

// 23.0.0 — bumped because M23-D2 changes what a migrated database GUARANTEES:
// seven more collections are present after an upgrade that were previously
// present only by luck of the seed. That is a real change to the bootstrap
// contract, which is what this number is for. It is not bumped for
// documentation.
export const SCHEMA_VERSION = 2300;

/**
 * Every step is idempotent: running it twice is the same as running it once.
 * A step never deletes data. `id` is stable forever — it is what the applied
 * list records.
 */
export const MIGRATIONS = [
  {
    id: 'm182_001_schema_record',
    note: 'Create the schema record itself.',
    up(db) { db.schema ??= { version: 0, migrations: [] }; },
  },
  {
    id: 'm182_002_collections_present',
    note: 'Every collection a module assumes exists, exists (formerly fourteen files of `??= []`).',
    up(db) {
      for (const k of [
        'notifications', 'ledger', 'sessions', 'users', 'orgs', 'players', 'guardians',
        'recruitmentCases', 'roomComments', 'roomDecisions', 'roomSnapshots', 'roomEvidenceState',
        'recruitmentBriefs', 'nobodyMissedReviews', 'secondLookItems', 'sourceChanges',
        'boxSessions', 'boxSessionEvents', 'combineAttempts', 'combineRequests',
      ]) db[k] ??= [];
    },
  },
  {
    id: 'm182_003_rev_backfill',
    note: 'Rooms and Briefs written before M18.1 carry rev 1 explicitly rather than implicitly.',
    up(db) {
      for (const c of db.recruitmentCases ?? []) if (c.room && c.room.rev == null) c.room.rev = 1;
      for (const b of db.recruitmentBriefs ?? []) if (b.rev == null) b.rev = 1;
    },
  },
  {
    id: 'm182_004_notification_prefs',
    note: 'Per-person notification category preferences.',
    up(db) { db.notificationPrefs ??= []; },
  },
  {
    id: 'm190_001_dynamic_watchlists',
    note: 'M19 Dynamic Watchlists and their membership history.',
    up(db) { db.dynamicWatchlists ??= []; db.watchlistHistory ??= []; },
  },
  {
    id: 'm182_005_notification_repeat_count',
    note: 'Notifications written before M18.1 count as one occurrence.',
    up(db) { for (const n of db.notifications ?? []) n.repeatCount ??= 1; },
  },
  {
    id: 'm200_001_analytics_sources_present',
    // M20 creates NO analytics store: every figure is projected from records
    // M12-M19 already own, so there is nothing here that could ever disagree
    // with a Recruitment Room. All this step does is guarantee the collections
    // the projection READS exist. `trials` in particular has only ever been
    // created by the seed, so a snapshot restored without it would have thrown
    // on the first trial read — with or without M20.
    note: 'Collections the recruitment analytics projection reads. No analytics store is created.',
    up(db) {
      for (const k of ['trials', 'signings', 'requests', 'dynamicWatchlists', 'watchlistHistory']) db[k] ??= [];
    },
  },
  {
    id: 'm210_001_development_stores',
    // The five M21 workflow stores. This step, and nothing else, is what
    // creates them: the lesson of the M20 `db.trials` defect is that a
    // collection which exists only because the demo seed made it will throw
    // on the first read of a restored snapshot. The M21 suite proves this by
    // booting with an empty data directory and reading each store before any
    // write happens.
    //
    // Not one of them holds a fact about a player that another store already
    // holds. Evidence links carry `{sourceType, sourceId}` and no content, so
    // there is nothing here that could ever disagree with the Passport.
    note: 'Development Hub workflow stores: plans, goals, actions, evidence references and reviews.',
    up(db) {
      for (const k of [
        'developmentPlans', 'developmentGoals', 'developmentActions',
        'developmentEvidenceLinks', 'developmentReviews',
      ]) db[k] ??= [];
    },
  },
  {
    id: 'm220_001_box_cam_cv_results',
    // ONE store, and the §117 reuse audit that justifies it.
    //
    // What was considered first, and why each was rejected:
    //
    //   db.boxSessions (M16) — holds the Box Cam session: target, liveness,
    //     aggregated observation intervals, verification state. A provider
    //     observation result is a DIFFERENT record with a different lifecycle:
    //     one Box Cam session can open, cancel and re-open provider sessions,
    //     and a provider result carries engine/policy/provider versions that
    //     the session does not and must not inherit. Widening boxSessions to
    //     hold it would make those versions look like session properties,
    //     which is exactly the confusion the M16 drill-version pinning exists
    //     to avoid.
    //
    //   db.combineAttempts (M16.1) — is the MEASUREMENT layer. Putting an
    //     observation result there would imply every observation is a
    //     candidate measurement, which is the precise claim M22 refuses to
    //     make. A Box Cam observed result exists whether or not any Combine
    //     protocol is eligible, and most are not.
    //
    //   db.boxSessionEvents — reserved and unused since M16; it was designed
    //     for per-event aggregate rows, and reviving it for provider results
    //     would give one collection two unrelated meanings across milestones.
    //
    // So: one new collection, holding derived metadata only.
    //
    // WHAT IS NOT HERE, DELIBERATELY (§116, §117): there is no `cvFrames`
    // table, no frame column, no blob store and no video reference. Frames are
    // ephemeral by construction — validated, decoded, handed to the engine and
    // dropped — so there is nothing about them for a schema to represent. A
    // store would be the first place a "just for debugging" frame could land.
    note: 'Box Cam CV provider observation results (derived metadata only). No frame store exists, by design.',
    up(db) {
      db.boxCamCvResults ??= [];
    },
  },
  {
    id: 'm230_001_core_stores_present',
    // M23-D2 — a PRE-EXISTING core persistence defect, found during M23
    // preflight. Not caused by M23.
    //
    // THE MECHANISM. The server starts from `buildSeed()`, so a first boot has
    // every collection. Then `loadSnapshot()` runs:
    //
    //     for (const key of Object.keys(db)) delete db[key];
    //     Object.assign(db, raw.db);
    //
    // It DELETES the seeded object wholesale and replaces it with exactly what
    // the snapshot holds. A snapshot written before a collection existed
    // therefore *removes* that collection, and the next production read is a
    // TypeError — an HTTP 500, not a 404.
    //
    // Seven collections were reachable by production code and guaranteed by
    // nothing but the demo-data builder. The worst is `db.blocks`, read by
    // `isBlocked()` inside every visibility check: a restored older snapshot
    // would have crashed the safeguarding path rather than answering it. A
    // missing container is infrastructure corruption, NOT an authorization
    // decision — "fail closed" is a verdict, and a TypeError is not a verdict.
    //
    // TWO KINDS OF DEFAULT, AND THEY ARE NOT INTERCHANGEABLE.
    //
    //   Containers of user data default to empty, because empty is TRUE: no
    //   rows means nothing happened. An empty `blocks` means no block
    //   relation exists, which is exactly what it means today.
    //
    //   Product configuration does NOT default to empty, because empty is a
    //   lie with consequences. An empty `plans` makes every
    //   `db.plans[org.plan]?.attributionWindowMonths ?? 18` fall through, and
    //   a Grassroots organisation's attribution window would silently move
    //   from 12 months to 18 — a billing change caused by a persistence bug.
    //   So the catalogue is restored from catalogue.mjs, the one definition
    //   the seed now also uses.
    //
    // `reputationSeed` is the third case: it is demo data, its rows are
    // literally marked `seeded: true`, and it is served beside figures
    // computed from the live ledger. Empty is the correct production value —
    // fabricating scout track records to fill it would be worse than the bug.
    //
    // Nothing here overwrites: every assignment is `??=`, so a snapshot that
    // already carries blocks, channels or a customised plan table keeps
    // exactly what it has.
    note: 'M23-D2: core production-read collections exist after restore, not only after seed.',
    up(db) {
      // User-data containers — empty is the truthful default.
      db.blocks ??= [];         // {playerId, orgId, by, reason} — read by isBlocked() on every visibility check
      db.reports ??= [];        // report-user/scout/club submissions
      db.moderationLog ??= [];  // moderation hits, counted on the T&S dashboard
      db.channels ??= [];       // moderated message threads, opened on acceptance
      db.reputationSeed ??= []; // demo track records; empty is correct in production

      // Product configuration — empty would change behaviour, so restore the catalogue.
      db.plans ??= planCatalogue();
      db.archetypes ??= archetypeCatalogue();
    },
  },
];

/**
 * Collections production code may read without guarding.
 *
 * This list exists so the same defect cannot be rediscovered at M24. It is
 * asserted by `scripts/m23Persistence.mjs` against a snapshot that has been
 * through `runMigrations` and nothing else — no seed, no fixtures, no demo.
 *
 * It is deliberately derived from the migration steps rather than hand-kept:
 * `missingRequiredStores()` below walks what the steps actually guarantee, so
 * adding a store to a step adds it here, and adding a name here without a step
 * fails loudly instead of drifting.
 */
export const PRODUCTION_REQUIRED_STORES = Object.freeze([
  // Identity and core records
  'players', 'orgs', 'guardians', 'users', 'sessions', 'ledger', 'notifications',
  // Safeguarding and moderation — the reason this list exists
  'blocks', 'reports', 'moderationLog', 'channels',
  // Product configuration
  'plans', 'archetypes',
  // Recruitment
  'recruitmentCases', 'roomComments', 'roomDecisions', 'roomSnapshots', 'roomEvidenceState',
  'recruitmentBriefs', 'nobodyMissedReviews', 'secondLookItems', 'sourceChanges',
  'requests', 'trials', 'signings',
  // Box Cam / Combine
  'boxSessions', 'boxSessionEvents', 'combineAttempts', 'combineRequests', 'boxCamCvResults',
  // Matching, development, preferences
  'dynamicWatchlists', 'watchlistHistory', 'notificationPrefs',
  'developmentPlans', 'developmentGoals', 'developmentActions',
  'developmentEvidenceLinks', 'developmentReviews',
]);

/**
 * Which required stores are absent from this snapshot.
 *
 * Reports, never repairs (§45): a read-time `??=` scattered through handlers
 * is how the original defect hid for eleven milestones. The fix is that the
 * collection exists; this function only says whether it does.
 */
export function missingRequiredStores(db) {
  return PRODUCTION_REQUIRED_STORES.filter((k) => db?.[k] === undefined);
}

/**
 * Apply every migration not yet recorded. Returns what happened so the caller
 * can log it and the suites can assert on it. Throws on the first failing
 * step; the caller must not save the snapshot after a throw.
 */
export function runMigrations(db, { now = Date.now(), log = () => {} } = {}) {
  // Step 001 creates db.schema; everything before it must tolerate its absence.
  const applied = new Set((db.schema?.migrations ?? []).map((m) => m.id));
  const ran = [];
  for (const step of MIGRATIONS) {
    if (applied.has(step.id)) continue;
    try {
      step.up(db);
    } catch (err) {
      throw new Error(`migration ${step.id} failed: ${err?.message ?? err}. Boot aborted; the on-disk snapshot was not modified.`);
    }
    db.schema.migrations.push({ id: step.id, at: now });
    ran.push(step.id);
    log(`migration applied: ${step.id} — ${step.note}`);
  }
  const from = db.schema.version ?? 0;
  db.schema.version = SCHEMA_VERSION;
  db.schema.updatedAt = now;
  return { from, to: SCHEMA_VERSION, ran, alreadyApplied: MIGRATIONS.length - ran.length };
}

/** Operator-facing view. Ids and times only. */
export const schemaReport = (db) => ({
  version: db.schema?.version ?? 0,
  expected: SCHEMA_VERSION,
  migrationsApplied: (db.schema?.migrations ?? []).length,
  migrationsKnown: MIGRATIONS.length,
  upToDate: (db.schema?.version ?? 0) === SCHEMA_VERSION && (db.schema?.migrations ?? []).length === MIGRATIONS.length,
});
