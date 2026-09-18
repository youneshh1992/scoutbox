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
import { MIGRATION_GUARANTEED } from '../storeContract.mjs';
import { SEEDED_POLICY_VERSIONS } from '../m25/policyVersions.mjs';

// 23.0.0 — bumped because M23-D2 changes what a migrated database GUARANTEES:
// seven more collections are present after an upgrade that were previously
// present only by luck of the seed. That is a real change to the bootstrap
// contract, which is what this number is for. It is not bumped for
// documentation.
//
// 23.0.1 — the M23 sweep found an eighth: `db.assessments`, declared REQUIRED
// by the journey projection and guaranteed by nothing but a module's `??=` at
// registration time. Same class of bug, one store further out.
//
// 23.0.2 — the boot-contract pass found two more, and a different mechanism:
// `db.idvQueue` and `db.orgNotes` were created by `??=` inside a request
// handler, so they existed only after the first write. A store that appears on
// first write is invisible to every boot-time check.
//
// 23.0.3 — M23 P3 adds ONE store, `db.recruitmentContacts`, the Contact
// workflow's own record. Justified in M23_P3_CONTACT_REUSE_AUDIT.md Part C.
//
// 23.0.4 — M23 P4B adds NO store. It adds neutral operational containers to
// every existing `db.trials` row (D-20): the row keeps its M12 meaning and
// its report-obligation `status`; the new fields say "nothing recorded" —
// never a fabricated schedule, attendance or completion.
//
// 23.0.5 — M23 P5.6B adds THREE stores for the ScoutBox Agent core app, the
// minimum set the P5.6A store proposal justified for this phase:
// `agentProfiles` (the licensed natural person's verification facets),
// `agencyAffiliations` (time-aware membership and roles in an agency
// organisation) and `representationAgreements` (the client-confirmed
// relationship record). The P5.6A transaction, consent and policy stores are
// deliberately NOT created here: they belong to P5.6C/D.
//
// 23.0.6 — M23 P5.6C adds FIVE stores for the Conflict & Compliance Engine,
// each justified in M23_P56C_FINAL_REPORT.md: `tsReviewers` (per-reviewer
// Trust & Safety identity — the G-C0 record), `jurisdictionPolicies` (the
// versioned policy layer, seeded from code, published thereafter under dual
// control), `regulatoryReviews` (attributed manual review items),
// `regulatoryConsents` (the append-only consent ledger) and
// `complianceContexts` (the minimal conflict-evaluation context — NOT a
// Transaction Room). It also gives every agent profile a fourth facet
// container, `domestic_authorisation`, empty by default.
//
// 23.0.7 — M23 P5.6D adds THREE stores for the Agent Transaction Workspace:
// `agentTransactions` (the frozen P5.6A §4 multi-party workspace entity),
// `transactionRepresentations` (the frozen P5.6A §5 (agent, party role,
// transaction) binding) and `transactionDocuments` (the document
// classification and visibility layer, which references the canonical evidence
// vault and stores no bytes of its own). No Offer store, no signing writer and
// no `agencyInvoices`: the first two are out of scope by mandate, and the third
// was named for P5.6D by the store proposal but is deferred with its reason
// recorded, because no fee workflow exists for it to serve.
export const SCHEMA_VERSION = 2307;

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
  {
    version: 2301,
    id: 'm230_002_assessments_present',
    // THE SAME DEFECT, ONE STORE FURTHER OUT. Found by the M23 sweep's
    // restore matrix, not by inspection: a pre-M23 snapshot upgraded cleanly,
    // kept all thirteen statuses — and then the journey route answered 500,
    // because `db.assessments` did not exist.
    //
    // It escaped the D2 pass because `m12/shared.mjs` does
    // `db.assessments ??= []` when the module registers, so a RUNNING server
    // always has it and no test that goes through HTTP can see the gap. That
    // is precisely the "registration order decides whether a core collection
    // exists" failure the D2 suite asserts against everywhere else — and
    // `buildRecruitmentJourney` is a pure function over a database, so it has
    // no module registration to rely on.
    //
    // `db.assessments` is read by the M23 journey (which DECLARES it
    // required), by M15's Passport projection, by M16.2's Trust evidence
    // source, by M13's group analytics and by M12's own routes. Empty is the
    // truthful default: no rows means no assessment was ever filed.
    note: 'M23 sweep: db.assessments is a journey-required store and must survive a restore.',
    up(db) {
      db.assessments ??= [];
    },
  },
  {
    version: 2302,
    id: 'm230_003_core_server_stores_present',
    // THE BOOT-CONTRACT PASS. Two collections owned by `server.mjs` itself
    // were created by `db.x ??= []` INSIDE a request handler — so they came
    // into existence on whichever request happened to arrive first, and not
    // before. Every read of them is guarded today, so nothing crashed; what
    // was wrong is subtler and worse.
    //
    // A store that appears on first write is invisible to every boot-time
    // check. `missingRequiredStores()` cannot report it, the STORE_MISSING log
    // cannot name it, and a restore that drops it looks healthy right up until
    // someone files the first note. Read-time repair is not a lifecycle; it is
    // the absence of one.
    //
    // `server.mjs` has no `register()` of its own to hold an init block, so
    // the core registry is the right home — and it means both survive
    // `loadSnapshot()` wiping the object, which is the whole point of D2.
    //
    //   idvQueue  guardian identity-verification queue (safeguarding-adjacent)
    //   orgNotes  a club's private notes on a player
    //
    // Both are containers of user data, so empty is the truthful default.
    note: 'M23 boot contract: core server-owned collections exist at boot, not on first write.',
    up(db) {
      db.idvQueue ??= [];
      db.orgNotes ??= [];
    },
  },
  {
    version: 2303,
    id: 'm230_004_recruitment_contacts',
    // M23 P3 — the Contact workflow store. ONE collection, and the reuse
    // audit that justifies it (M23_P3_CONTACT_REUSE_AUDIT.md, Part C):
    //
    //   db.requests is the recipient-visible object and every one of its
    //   readers assumes a row is visible, so a DRAFT cannot live there;
    //   delivery truth (delivered / failed / responded / recorded) belongs to
    //   the communication and is forbidden from becoming a case state; and an
    //   attested external contact creates nothing in anyone's Inbox.
    //
    // It is guaranteed here — by the registry — rather than by a `??=` at
    // module registration, so a restored older snapshot has it before any
    // request can reach the projector that declares it required.
    // A container of user data: empty is the truthful default.
    note: 'M23 P3: the Contact workflow store (recruitmentContacts).',
    up(db) {
      db.recruitmentContacts ??= [];
    },
  },
  {
    id: 'm230_005_trial_workflow',
    version: 2304,
    // M23 P4B — the Trial workflow. NO new store: `db.trials` is extended
    // additively (M23_P4A_DECISION_REGISTER.md D-1, D-20). Every pre-P4B row
    // gains the neutral containers below and reads as `legacy_accepted`: an
    // accepted trial with no schedule revision, no session list, no attendance
    // record and no completion. Nothing is backfilled from `proposedDate` —
    // a date the club typed is not a confirmed schedule, and inventing one
    // would let a case reach `trial_scheduled` on evidence nobody recorded.
    //
    // Idempotent (`??=`), never destructive, tolerant of a missing or
    // malformed `trials` collection (the boot-contract step already
    // guarantees the collection exists; this one only shapes its rows).
    note: 'M23 P4B: additive Trial workflow containers on db.trials (workflowState, caseId, schedule, attendance, completion, keys, rev, history, reminders).',
    up(db) {
      db.trials ??= [];
      if (!Array.isArray(db.trials)) return;
      for (const t of db.trials) {
        if (!t || typeof t !== 'object') continue;
        t.workflowState ??= 'legacy_accepted';
        t.caseId ??= null;
        t.schedule ??= null;
        t.attendance ??= [];
        t.completion ??= null;
        t.keys ??= {};
        t.rev ??= 1;
        t.history ??= [];
        t.reminders ??= {};
      }
    },
  },
  {
    id: 'm240_001_agent_core_stores',
    version: 2305,
    // M23 P5.6B — ScoutBox Agent core. Three containers of user data (empty is
    // the truthful default) plus two idempotent, non-destructive bootstraps:
    //
    //   1. Every existing agency staff row (`db.users` whose organisation is
    //      of type 'agency', not removed) gains an `agencyAffiliations` row so
    //      the permission matrix has something to read. Nobody is made a
    //      licensed agent by this step — a self-typed login role is not a
    //      licence (P5.6A S9). A role matching the platform's lead heuristic
    //      becomes `agency_admin`; everyone else becomes `assistant`; an
    //      agency left with no admin gets its earliest member as admin, so a
    //      restored snapshot can still be administered.
    //   2. Every M13 F10 `db.representations` row is mirrored into
    //      `representationAgreements` as a LEGACY, agency-level record with
    //      `agentUserId: null` (P5.6A store proposal §3). A legacy row names
    //      no licensed individual and, by construction of the access
    //      predicate, authorises no regulated action. The source rows are
    //      left in place: the F10 routes and the M16.2 relationship source
    //      keep reading them until P5.6E retires that lane.
    note: 'M23 P5.6B: Agent core stores (agentProfiles, agencyAffiliations, representationAgreements) with non-destructive bootstraps.',
    up(db) {
      db.agentProfiles ??= [];
      db.agencyAffiliations ??= [];
      db.representationAgreements ??= [];
      const now = Date.now();
      const isLead = (role) => /head|director|lead|manager|owner|chief/i.test(role ?? '');
      let seq = 0;
      const id = (p) => `${p}-mig2305-${now.toString(36)}-${(seq += 1)}`;
      const agencies = (db.orgs ?? []).filter((o) => o && o.type === 'agency');
      for (const org of agencies) {
        const members = (db.users ?? []).filter((u) => u && u.orgId === org.id && !u.removedAt)
          .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
        for (const u of members) {
          if (db.agencyAffiliations.some((a) => a && a.agencyOrgId === org.id && a.userId === u.id)) continue;
          const tiers = [isLead(u.role) ? 'agency_admin' : 'assistant'];
          db.agencyAffiliations.push({
            id: id('aff'), agencyOrgId: org.id, userId: u.id, tiers,
            // Never in the future: a clock skew on the user row must not
            // produce a membership that has not "started" yet.
            startedAt: Math.min(typeof u.createdAt === 'number' ? u.createdAt : now, now), endedAt: null, endedReason: null,
            createdAt: now, rev: 1, revAt: now, revBy: null,
            history: [{ id: id('aud'), at: now, action: 'agency_affiliation_created', by: { kind: 'system', userId: null, name: 'migration 2305' }, detail: { tiers, legacy: true } }],
          });
        }
        const hasAdmin = db.agencyAffiliations.some((a) => a && a.agencyOrgId === org.id && a.endedAt == null && (a.tiers ?? []).includes('agency_admin'));
        if (!hasAdmin) {
          const first = db.agencyAffiliations.filter((a) => a && a.agencyOrgId === org.id && a.endedAt == null)
            .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))[0];
          if (first && !(first.tiers ?? []).includes('agency_admin')) {
            first.tiers = [...(first.tiers ?? []), 'agency_admin'];
            first.history.push({ id: id('aud'), at: now, action: 'agency_affiliation_updated', by: { kind: 'system', userId: null, name: 'migration 2305' }, detail: { tiers: first.tiers, legacy: true } });
          }
        }
      }
      for (const r of db.representations ?? []) {
        if (!r || !r.id) continue;
        if (db.representationAgreements.some((a) => a?.legacy?.fromRepresentationId === r.id)) continue;
        const status = r.status === 'active' && r.endAt && r.endAt < now ? 'expired'
          : r.status === 'proposed' ? 'proposed'
            : r.status === 'active' ? 'active'
              : r.status === 'withdrawn' ? 'terminated_by_client'
                : r.status === 'disputed' ? 'disputed' : 'terminated_by_client';
        db.representationAgreements.push({
          id: id('rep'), agentUserId: null, agencyOrgId: r.agencyOrgId ?? null,
          clientKind: 'player', clientId: r.playerId, isRegulatoryMinor: false,
          jurisdiction: null, scope: [r.scope === 'contracts_only' ? 'employment' : r.scope === 'commercial_only' ? 'commercial' : 'employment'],
          exclusive: false, termMonths: null, startAt: r.startAt ?? null, endAt: r.endAt ?? null,
          status, proposedAt: r.createdAt ?? null, confirmedAt: r.confirmedAt ?? null, confirmedBy: r.confirmedAt ? { kind: 'player', id: r.playerId } : null,
          declinedAt: null, terminatedAt: r.withdrawnAt ?? null, terminatedBy: r.withdrawnAt ? 'client' : null, terminationReasonCode: null,
          disputedAt: r.disputedAt ?? null, disputeReason: null,
          shareWithAgencyStaff: false, documents: [],
          legacy: { fromRepresentationId: r.id, regulatoryStatus: 'not_regulated_record', representativeName: r.representativeName ?? null },
          policyVersion: 1, keys: {}, createdAt: now, rev: 1, revAt: now, revBy: null,
          history: [{ id: id('aud'), at: now, action: 'representation_requested', by: { kind: 'system', userId: null, name: 'migration 2305' }, detail: { legacy: true, phase: status } }],
        });
      }
    },
  },
  {
    id: 'm250_001_compliance_stores',
    version: 2306,
    // M23 P5.6C — Conflict & Compliance Engine. Five containers plus three
    // idempotent, non-destructive bootstraps:
    //
    //   1. The three policy versions the P5.6A regulatory snapshot encoded
    //      (jp-fifa-2025-1, jp-eng-2026-27-1, jp-usa-2024-1) are seeded as
    //      PUBLISHED rows attributed to this migration. Later versions are
    //      published only through the attributed, dual-controlled route.
    //   2. Every agent profile gains an empty `domestic_authorisation` facet
    //      container (P5.6A DR-53: licence ≠ national registration ≠ domestic
    //      authorisation). Empty is the truthful default; nothing is verified.
    //   3. Facets already sitting in MANUAL_REVIEW_REQUIRED and relationships
    //      already `disputed` get a PENDING review item, requested by this
    //      migration, so the attributed review lane sees them. No reviewer
    //      identity is invented; no historical record is rewritten.
    //
    //   `tsReviewers` starts EMPTY. Production reviewers come from the
    //   operator bootstrap (TS_REVIEWER_BOOTSTRAP_*) or from an existing
    //   administrator; the shared admin key can create none.
    note: 'M23 P5.6C: compliance stores (tsReviewers, jurisdictionPolicies, regulatoryReviews, regulatoryConsents, complianceContexts); seeded policy versions; domestic_authorisation facet container; review items for pre-existing manual-review facets and disputes.',
    up(db) {
      db.tsReviewers ??= [];
      db.jurisdictionPolicies ??= [];
      db.regulatoryReviews ??= [];
      db.regulatoryConsents ??= [];
      db.complianceContexts ??= [];
      const now = Date.now();
      let seq = 0;
      const id = (p) => `${p}-mig2306-${now.toString(36)}-${(seq += 1)}`;
      const system = { kind: 'system', userId: null, name: 'migration 2306' };
      for (const v of SEEDED_POLICY_VERSIONS) {
        if (db.jurisdictionPolicies.some((p) => p && p.id === v.id)) continue;
        db.jurisdictionPolicies.push({
          ...structuredClone(v), publishedAt: now, proposedBy: null, approvedBy: null,
          createdAt: now, rev: 1, revAt: now, revBy: null,
          history: [{ id: id('aud'), at: now, action: 'policy_version_published', by: system, detail: { policyVersion: v.id, seeded: true } }],
        });
      }
      for (const p of db.agentProfiles ?? []) {
        if (!p) continue;
        p.facets ??= {};
        p.facets.domestic_authorisation ??= {};
        const facets = [['fifa_licence', null, p.facets.fifa_licence]];
        for (const f of ['national_registration', 'domestic_authorisation', 'minors_authorisation']) for (const [ma, rec] of Object.entries(p.facets[f] ?? {})) facets.push([f, ma, rec]);
        for (const [facet, ma, rec] of facets) {
          if (!rec || rec.state !== 'MANUAL_REVIEW_REQUIRED') continue;
          if (db.regulatoryReviews.some((r) => r && r.kind === 'verification_facet' && r.subject?.profileId === p.id && r.subject?.facet === facet && (r.subject?.memberAssociation ?? null) === ma && (r.status === 'PENDING' || r.status === 'IN_REVIEW'))) continue;
          db.regulatoryReviews.push({
            id: id('rrv'), kind: 'verification_facet', status: 'PENDING', agencyOrgId: p.agencyOrgId ?? null, agentUserId: p.userId,
            subject: { profileId: p.id, userId: p.userId, facet, memberAssociation: ma, referenceHash: rec.reference ? String(String(rec.reference).length) : null },
            reasons: [{ code: 'NO_PROVIDER', ruleId: null, ruleStatus: null, policyVersion: null }], policyVersions: [], snapshot: null,
            requestedAt: now, requestedBy: system, startedAt: null, startedBy: null, decidedAt: null, decision: null, supersedes: null, supersededBy: null,
            keys: {}, rev: 1, revAt: now, revBy: null,
            history: [{ id: id('aud'), at: now, action: 'regulatory_review_requested', by: system, detail: { kind: 'verification_facet', reasonCodes: ['NO_PROVIDER'], migrated: true } }],
          });
        }
      }
      for (const a of db.representationAgreements ?? []) {
        if (!a || a.status !== 'disputed') continue;
        if (db.regulatoryReviews.some((r) => r && r.kind === 'representation_dispute' && r.subject?.agreementId === a.id && (r.status === 'PENDING' || r.status === 'IN_REVIEW'))) continue;
        db.regulatoryReviews.push({
          id: id('rrv'), kind: 'representation_dispute', status: 'PENDING', agencyOrgId: a.agencyOrgId ?? null, agentUserId: a.agentUserId ?? null,
          subject: { agreementId: a.id }, reasons: [{ code: 'CLIENT_DISPUTE', ruleId: null, ruleStatus: null, policyVersion: null }], policyVersions: [], snapshot: null,
          requestedAt: now, requestedBy: system, startedAt: null, startedBy: null, decidedAt: null, decision: null, supersedes: null, supersededBy: null,
          keys: {}, rev: 1, revAt: now, revBy: null,
          history: [{ id: id('aud'), at: now, action: 'regulatory_review_requested', by: system, detail: { kind: 'representation_dispute', reasonCodes: ['CLIENT_DISPUTE'], migrated: true } }],
        });
      }
    },
  },
  {
    id: 'm260_001_transaction_stores',
    version: 2307,
    // M23 P5.6D — Agent Transaction Workspace. THREE containers and nothing
    // else. There is no data to backfill and none is invented: a transaction
    // is a new concept, no earlier record is one, and turning an existing
    // `recruitmentCases` row or `complianceContexts` row into a transaction
    // would be exactly the conflation P5.6D §3 forbids.
    //
    //   `agentTransactions`         the frozen P5.6A §4 entity: the multi-party
    //                              workspace, its parties, its status ladder,
    //                              its compliance snapshot, its scoped notes,
    //                              its linked threads and its append-only
    //                              history.
    //   `transactionRepresentations` the frozen P5.6A §5 store, separate from
    //                              the transaction on purpose: the conflict
    //                              engine's unit of evaluation is the (agent,
    //                              party role, transaction) triple, and a triple
    //                              with its own lifecycle, rev and review link
    //                              is a record, not a field.
    //   `transactionDocuments`      the classification layer: documentType,
    //                              owner, visibility class, version chain,
    //                              expiry and a REFERENCE into the canonical
    //                              evidence vault. It stores no bytes; ScoutBox
    //                              has one upload path and this is not a second.
    note: 'M23 P5.6D: transaction stores (agentTransactions, transactionRepresentations, transactionDocuments). Three empty containers; nothing is backfilled and no existing record is reinterpreted as a transaction.',
    up(db) {
      db.agentTransactions ??= [];
      db.transactionRepresentations ??= [];
      db.transactionDocuments ??= [];
    },
  },
];

/**
 * Collections production code may read without guarding.
 *
 * DERIVED from `storeContract.mjs`, which is the one place ownership and
 * guarantee are declared. This used to be a second hand-kept list beside that
 * one, and the two disagreed by two entries — `db.schema` (the registry's own
 * record, not a collection) and `db.reputationSeed`.
 *
 * `reputationSeed` is created by a migration step but is deliberately NOT
 * required: its rows are demo track records marked `seeded: true`, and empty is
 * the correct production value. "Guaranteed to exist" and "must be non-empty
 * for production to be healthy" are different claims, and only the first one is
 * what this list makes.
 *
 * Asserted by `scripts/m23Persistence.mjs` against a snapshot that has been
 * through `runMigrations` and nothing else — no seed, no fixtures, no demo.
 */
export const PRODUCTION_REQUIRED_STORES = MIGRATION_GUARANTEED.filter((s) => s !== 'reputationSeed');

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
