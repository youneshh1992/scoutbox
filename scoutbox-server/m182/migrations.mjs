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

export const SCHEMA_VERSION = 2200; // 22.0.0

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
];

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
