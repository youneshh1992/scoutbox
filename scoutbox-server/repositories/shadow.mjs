/**
 * The verified shadow of the core identity collections (plan step S1).
 *
 * The blob snapshot is still the source of truth for orgs, guardians, players
 * and sessions. When shadow validation is ENABLED (SCOUTBOX_SHADOW_VALIDATION=1,
 * off by default) the store calls `project(snapshot)` inside each save
 * transaction and this module rewrites the five core tables from the
 * in-memory collections: a deterministic DELETE + INSERT, row by row, inside a
 * SAVEPOINT the store owns. A row the target schema refuses (a CHECK, a
 * foreign key, the unique e-mail) is skipped and recorded with its reason; a
 * row that needs an adjustment to fit (a dangling guardian id) is written with
 * the adjustment and recorded as a finding. A failure of the projection as a
 * whole rolls back only the savepoint: the blob save always commits.
 *
 * When validation is disabled (the default) nothing here runs during a save:
 * the save path is exactly the S0 path. The tables keep whatever the last
 * projection wrote, and `report()` says so: it never presents disabled or
 * stale rows as a current reconciliation. The isolated command
 * `scripts/validateShadow.mjs` runs the same projection against a copy of a
 * database file.
 *
 * What is persisted about a projection: a counts-only summary in the store's
 * `meta` table (`shadowProjectedAt` = the `savedAt` of the save it ran in,
 * `shadowSummary` = per-table source/written/skipped/findings counts). Row ids
 * and refusal reasons are kept in memory only, for the admin report and the
 * validation command. Session tokens are stored only as sha256 hashes here;
 * the plain token never reaches a table or a report.
 */
import crypto from 'node:crypto';

export const CORE_SHADOW_TABLES = Object.freeze(['orgs', 'guardians', 'players', 'guardian_children', 'sessions']);

/** Report statuses, from "nothing to say" to "the tables match the last save". */
export const SHADOW_STATUS = Object.freeze({
  NEVER: 'never',       // no projection has ever run against this file
  FAILED: 'failed',     // the last projection attempt in this process threw; tables hold the previous projection
  STALE: 'stale',       // the snapshot has been saved since the last projection (or validation is off)
  PARTIAL: 'partial',   // current, but the target schema refused at least one row
  COMPLETE: 'complete', // current, every snapshot row is in the tables
});

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const bool = (v) => (v ? 1 : 0);
const triBool = (v) => (v === null || v === undefined ? null : v ? 1 : 0);
const int = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);
const real = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v) => (typeof v === 'string' ? v : v === null || v === undefined ? null : String(v));
const reason = (err) => String(err?.message ?? err).replace(/^SQLITE_\w+:\s*/, '').slice(0, 160);

export function createCoreIdentityShadow({ sqlite, sessionTtlMs = 30 * 24 * 3600 * 1000, now = Date.now }) {
  // The store owns `meta`; the shadow records its counts-only summary there so a
  // restarted process (or a tool reading the file) can tell fresh from stale.
  sqlite.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  const ins = {
    orgs: sqlite.prepare(`INSERT INTO orgs (id, name, type, level, plan, country, city, lat, lng, federation, federation_registration_id,
      trusted_partner, verified, verified_domain, safeguarding_contract_signed, suspended, password_hash, email_domain, email_domain_verified,
      mfa_required_for_leads, verification_revoked_at, verification_org_type, created_at)
      VALUES (@id, @name, @type, @level, @plan, @country, @city, @lat, @lng, @federation, @federation_registration_id,
      @trusted_partner, @verified, @verified_domain, @safeguarding_contract_signed, @suspended, @password_hash, @email_domain, @email_domain_verified,
      @mfa_required_for_leads, @verification_revoked_at, @verification_org_type, @created_at)`),
    guardians: sqlite.prepare(`INSERT INTO guardians (id, name, email, password_hash, email_verified, email_code_hash, id_verified, idv_reference,
      disclaimer_accepted, disclaimer_accepted_at, co_guardian_of, prefs_quiet_start, prefs_quiet_end, prefs_school_hours_mute, prefs_timezone, created_at)
      VALUES (@id, @name, @email, @password_hash, @email_verified, @email_code_hash, @id_verified, @idv_reference,
      @disclaimer_accepted, @disclaimer_accepted_at, @co_guardian_of, @prefs_quiet_start, @prefs_quiet_end, @prefs_school_hours_mute, @prefs_timezone, @created_at)`),
    players: sqlite.prepare(`INSERT INTO players (id, name, birth_date, country, city, position, foot, height_cm, weight_kg, squad_number,
      contract_until_date, market_value_range, agent_name, academy_plus, first_team_seeker, availability, contract_status, level, football_category,
      identity_verified, guardian_id, lat, lng, stats_appearances, stats_goals, stats_assists, stats_pace_kmh, stats_pass_completion_pct,
      stats_duel_success_pct, stats_clean_sheets, medical_shared, medical_condition_status, prefs_quiet_start, prefs_quiet_end,
      prefs_school_hours_mute, prefs_timezone, programme_track, programme_started_at, password_hash, created_at)
      VALUES (@id, @name, @birth_date, @country, @city, @position, @foot, @height_cm, @weight_kg, @squad_number,
      @contract_until_date, @market_value_range, @agent_name, @academy_plus, @first_team_seeker, @availability, @contract_status, @level, @football_category,
      @identity_verified, @guardian_id, @lat, @lng, @stats_appearances, @stats_goals, @stats_assists, @stats_pace_kmh, @stats_pass_completion_pct,
      @stats_duel_success_pct, @stats_clean_sheets, @medical_shared, @medical_condition_status, @prefs_quiet_start, @prefs_quiet_end,
      @prefs_school_hours_mute, @prefs_timezone, @programme_track, @programme_started_at, @password_hash, @created_at)`),
    guardian_children: sqlite.prepare('INSERT INTO guardian_children (guardian_id, player_id, role) VALUES (@guardian_id, @player_id, @role)'),
    sessions: sqlite.prepare(`INSERT INTO sessions (token_hash, sid, kind, ref_id, org_user_id, via, created_at, expires_at)
      VALUES (@token_hash, @sid, @kind, @ref_id, @org_user_id, @via, @created_at, @expires_at)`),
  };
  const del = Object.fromEntries(CORE_SHADOW_TABLES.map((t) => [t, sqlite.prepare(`DELETE FROM ${t}`)]));
  const count = Object.fromEntries(CORE_SHADOW_TABLES.map((t) => [t, sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`)]));
  const orgUserExists = sqlite.prepare('SELECT 1 FROM org_users WHERE id = ?');
  const metaGet = sqlite.prepare('SELECT value FROM meta WHERE key = ?');
  const metaPut = sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

  let last = null; // this process's last projection attempt, with row ids and reasons

  const rows = (db, name) => (Array.isArray(db?.[name]) ? db[name] : []);

  function orgParams(o) {
    return {
      id: text(o.id), name: text(o.name), type: text(o.type), level: text(o.level), plan: text(o.plan), country: text(o.country),
      city: text(o.location?.city), lat: real(o.location?.lat), lng: real(o.location?.lng),
      federation: text(o.federationRef?.federation), federation_registration_id: text(o.federationRef?.registrationId),
      trusted_partner: bool(o.trustedPartner), verified: bool(o.verified), verified_domain: text(o.verifiedDomain),
      safeguarding_contract_signed: bool(o.safeguardingContractSigned), suspended: bool(o.suspended), password_hash: text(o.password),
      email_domain: text(o.emailDomain), email_domain_verified: bool(o.emailDomainVerified), mfa_required_for_leads: bool(o.mfaRequiredForLeads),
      verification_revoked_at: int(o.verification?.revokedAt), verification_org_type: text(o.verification?.orgType), created_at: int(o.createdAt),
    };
  }
  function guardianParams(g) {
    return {
      id: text(g.id), name: text(g.name), email: text(g.email), password_hash: text(g.password), email_verified: bool(g.emailVerified),
      email_code_hash: g.emailCode ? sha256(g.emailCode) : null, id_verified: bool(g.idVerified), idv_reference: text(g.idvReference),
      disclaimer_accepted: bool(g.disclaimerAccepted), disclaimer_accepted_at: null, co_guardian_of: text(g.coGuardianOf),
      prefs_quiet_start: text(g.notificationPrefs?.quietStart), prefs_quiet_end: text(g.notificationPrefs?.quietEnd),
      prefs_school_hours_mute: triBool(g.notificationPrefs?.schoolHoursMute), prefs_timezone: text(g.notificationPrefs?.timezone), created_at: int(g.createdAt),
    };
  }
  function playerParams(p, guardianId) {
    const s = p.stats && typeof p.stats === 'object' ? p.stats : {};
    return {
      id: text(p.id), name: text(p.name), birth_date: text(p.dob), country: text(p.country), city: text(p.city), position: text(p.position) || null,
      foot: text(p.foot) || null, height_cm: int(p.heightCm), weight_kg: int(p.weightKg), squad_number: int(p.squadNumber),
      contract_until_date: text(p.contractUntil), market_value_range: text(p.marketValueRange), agent_name: text(p.agentName),
      academy_plus: bool(p.academyPlus), first_team_seeker: bool(p.firstTeamSeeker), availability: text(p.availability) ?? 'not_seeking',
      contract_status: text(p.contractStatus) ?? 'unknown', level: text(p.level) ?? 'amateur', football_category: text(p.footballCategory),
      identity_verified: bool(p.identityVerified), guardian_id: guardianId, lat: real(p.location?.lat), lng: real(p.location?.lng),
      stats_appearances: int(s.appearances), stats_goals: int(s.goals), stats_assists: int(s.assists), stats_pace_kmh: real(s.paceKmh),
      stats_pass_completion_pct: real(s.passCompletionPct), stats_duel_success_pct: real(s.duelSuccessPct), stats_clean_sheets: int(s.cleanSheets),
      medical_shared: bool(p.medical?.shared), medical_condition_status: text(p.medical?.conditionStatus) ?? 'unknown',
      prefs_quiet_start: text(p.notificationPrefs?.quietStart), prefs_quiet_end: text(p.notificationPrefs?.quietEnd),
      prefs_school_hours_mute: triBool(p.notificationPrefs?.schoolHoursMute), prefs_timezone: text(p.notificationPrefs?.timezone),
      programme_track: text(p.programme?.track), programme_started_at: int(p.programme?.startedAt), password_hash: text(p.password), created_at: int(p.createdAt),
    };
  }

  const countsOnly = (result) => ({
    at: result.at,
    savedAt: result.savedAt,
    durationMs: result.durationMs,
    tables: Object.fromEntries(Object.entries(result.tables).map(([t, r]) => [t, { source: r.source, written: r.written, skipped: r.skipped.length, findings: r.findings.length }])),
  });

  /**
   * Rewrite the five tables from the snapshot. Called by the store inside the
   * save transaction (within its own SAVEPOINT) when validation is enabled,
   * and by the validation command. `savedAt` is the save this projection
   * belongs to; it is what makes the report's freshness decidable later.
   * Returns the per-table result and remembers it for `report()`. Throws only
   * on a failure that is not a single row — the store then rolls the
   * savepoint back, and the persisted summary is not updated.
   */
  function project(db, { savedAt = null } = {}) {
    const startedAt = now();
    const result = { at: startedAt, savedAt: int(savedAt), durationMs: 0, error: null, tables: {} };
    const table = (name) => (result.tables[name] ??= { source: 0, written: 0, skipped: [], findings: [] });
    for (const t of CORE_SHADOW_TABLES) table(t);
    const attempt = (name, params, id) => {
      try { ins[name].run(params); table(name).written += 1; return true; } catch (err) { table(name).skipped.push({ id, reason: reason(err) }); return false; }
    };
    try {
      // Children first, parents last: foreign keys are enforced on every statement.
      for (const t of ['sessions', 'guardian_children', 'players', 'guardians', 'orgs']) del[t].run();

      for (const o of rows(db, 'orgs')) {
        table('orgs').source += 1;
        if (!o || typeof o !== 'object') { table('orgs').skipped.push({ id: null, reason: 'not an object' }); continue; }
        attempt('orgs', orgParams(o), o.id);
      }

      const guardianIds = new Set();
      const allGuardians = rows(db, 'guardians');
      for (const g of allGuardians) {
        table('guardians').source += 1;
        if (!g || typeof g !== 'object') { table('guardians').skipped.push({ id: null, reason: 'not an object' }); continue; }
        const params = guardianParams(g);
        if (params.co_guardian_of && !allGuardians.some((x) => x?.id === params.co_guardian_of)) {
          table('guardians').findings.push({ id: g.id, finding: `coGuardianOf ${params.co_guardian_of} does not exist; written as NULL` });
          params.co_guardian_of = null;
        }
        if (attempt('guardians', params, g.id)) guardianIds.add(g.id);
      }

      const playerIds = new Set();
      const primaryGuardianOf = new Map();
      for (const p of rows(db, 'players')) {
        table('players').source += 1;
        if (!p || typeof p !== 'object') { table('players').skipped.push({ id: null, reason: 'not an object' }); continue; }
        let guardianId = text(p.guardianId) || null;
        if (guardianId && !guardianIds.has(guardianId)) {
          table('players').findings.push({ id: p.id, finding: `guardianId ${guardianId} does not exist; written as NULL` });
          guardianId = null;
        }
        if (attempt('players', playerParams(p, guardianId), p.id)) { playerIds.add(p.id); if (guardianId) primaryGuardianOf.set(p.id, guardianId); }
      }

      for (const g of allGuardians) {
        if (!g || typeof g !== 'object' || !guardianIds.has(g.id)) continue;
        for (const childId of Array.isArray(g.childIds) ? g.childIds : []) {
          table('guardian_children').source += 1;
          if (!playerIds.has(childId)) { table('guardian_children').skipped.push({ id: `${g.id}/${childId}`, reason: 'child player does not exist' }); continue; }
          attempt('guardian_children', { guardian_id: g.id, player_id: childId, role: primaryGuardianOf.get(childId) === g.id ? 'primary' : 'co' }, `${g.id}/${childId}`);
        }
      }

      for (const s of rows(db, 'sessions')) {
        table('sessions').source += 1;
        if (!s || typeof s !== 'object' || !s.token) { table('sessions').skipped.push({ id: s?.sid ?? null, reason: 'no token' }); continue; }
        const createdAt = int(s.createdAt);
        const orgUserId = s.kind === 'org' ? text(s.userId) : null;
        if (orgUserId && !orgUserExists.get(orgUserId)) { table('sessions').skipped.push({ id: s.sid, reason: `org user ${orgUserId} does not exist` }); continue; }
        attempt('sessions', {
          token_hash: sha256(s.token), sid: text(s.sid) ?? sha256(`sid:${s.token}`).slice(0, 12), kind: text(s.kind), ref_id: text(s.refId),
          org_user_id: orgUserId, via: text(s.via), created_at: createdAt, expires_at: createdAt === null ? null : createdAt + sessionTtlMs,
        }, s.sid);
      }

      result.durationMs = now() - startedAt;
      // Counts only. Written inside the same savepoint, so a rolled-back
      // projection leaves the previous summary in place.
      metaPut.run('shadowProjectedAt', String(result.savedAt ?? ''));
      metaPut.run('shadowSummary', JSON.stringify(countsOnly(result)));
    } catch (err) {
      result.error = reason(err);
      result.durationMs = now() - startedAt;
      last = result;
      throw err;
    }
    last = result;
    return result;
  }

  /** The persisted counts-only summary of the last successful projection, or null. */
  function persistedSummary() {
    const raw = metaGet.get('shadowSummary')?.value;
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  /**
   * Reconciliation. `enabled` says whether the store projects on save in this
   * process. Freshness is decided from the file: the tables are current when
   * the last projection ran in the save whose `savedAt` the meta table holds.
   * Without `details` the report carries counts and statuses only (it is
   * served to anyone on /capabilities); with `details` it adds this process's
   * row ids, refusal reasons and the last error text (admin and tooling).
   */
  function report(db, { enabled = false, details = false } = {}) {
    const summary = persistedSummary();
    const savedAt = int(Number(metaGet.get('savedAt')?.value));
    const projectedAt = int(Number(metaGet.get('shadowProjectedAt')?.value));
    const current = summary !== null && savedAt !== null && projectedAt === savedAt;

    let status;
    if (last?.error) status = SHADOW_STATUS.FAILED;
    else if (!summary) status = SHADOW_STATUS.NEVER;
    else if (!current) status = SHADOW_STATUS.STALE;
    else {
      const totalSkipped = Object.values(summary.tables).reduce((n, t) => n + t.skipped, 0);
      const allInTables = CORE_SHADOW_TABLES.every((t) => count[t].get().n === summary.tables[t]?.written);
      status = totalSkipped === 0 && allInTables ? SHADOW_STATUS.COMPLETE : SHADOW_STATUS.PARTIAL;
    }

    const tables = {};
    for (const t of CORE_SHADOW_TABLES) {
      const snapshotRows = t === 'guardian_children'
        ? rows(db, 'guardians').reduce((n, g) => n + (Array.isArray(g?.childIds) ? g.childIds.length : 0), 0)
        : rows(db, t).length;
      const tableRows = count[t].get().n;
      const s = summary?.tables?.[t] ?? null;
      tables[t] = {
        snapshotRows,                                   // in memory now
        tableRows,                                      // in the file now
        projectedRows: s?.source ?? null,               // snapshot rows seen by the last projection
        skipped: s?.skipped ?? null,
        findings: s?.findings ?? null,
        // Every projected row is either in the table or named as skipped.
        accountedFor: s ? tableRows === s.written && s.written + s.skipped === s.source : null,
      };
      if (details) {
        const lastT = last?.tables?.[t];
        tables[t].details = lastT ? { skipped: lastT.skipped.slice(0, 20), findings: lastT.findings.slice(0, 20) } : null;
      }
    }

    const out = {
      mode: 'shadow',
      sourceOfTruth: 'snapshot',
      enabled,
      status,
      reconciled: status === SHADOW_STATUS.COMPLETE,
      lastProjectionAt: summary?.at ?? null,
      lastProjectionSavedAt: projectedAt,
      snapshotSavedAt: savedAt,
      lastProjectionMs: summary?.durationMs ?? null,
      tables,
      note: enabled
        ? 'Shadow validation is on: the five tables are rewritten from the snapshot inside every save. The snapshot stays the source of truth; nothing reads these tables.'
        : 'Shadow validation is off (default): saves do not touch these tables. Rows shown are from the last projection, if any; run scripts/validateShadow.mjs against a copy for a current reconciliation.',
    };
    if (details) {
      out.lastError = last?.error ?? null;
      out.detailsNote = last ? 'Row ids and reasons are from the last projection in this process.' : 'No projection has run in this process; row-level details are available from the validation command.';
    }
    return out;
  }

  return { project, report, persistedSummary, tables: CORE_SHADOW_TABLES, last: () => last };
}
