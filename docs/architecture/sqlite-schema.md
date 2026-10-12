# ScoutBox relational SQLite schema

Status: design proposed, executable DDL in `docs/architecture/sql/`, implementation steps
S0 (staff), S1 (core identity shadow, corrected after acceptance review), S2 (sessions
live, hashed tokens), S3 (organisations live, `org_users` rebuilt STRICT with its
foreign key) and S4a (players, guardians and `guardian_children` live with the
transitional `facets_json`; the `media_deletions` queue; the S1 shadow retired) done
(§5.0 says exactly which parts are implemented, proposed, or waiting on a decision). Companion
document: [`sqlite-migration-plan.md`](./sqlite-migration-plan.md). Written 10 October
2026 on branch `feat/sqlite-schema`.

Every statement in this document is tagged by how much we know:

- **FACT** — verified by reading or running the code on this branch (file and line given).
- **DECISION** — a design choice made in this document; the reason is given with it.
- **ASSUMPTION** — something the design relies on that the code does not prove.
- **OPEN** — a question that needs the Founder or a later step to settle.

Sections: 1 starting point · 2 storage today and the review's claims · 3 inventory of every
collection · 4 conventions · 5 schema by domain · 6 indexes · 7 engine configuration ·
8 schema versioning · 9 tenancy and safeguarding in the schema · 10 retention and deletion ·
11 existing security weaknesses · 12 facts, decisions, assumptions, open questions · 13 sources.

---

## 1. Starting point

FACT. The work was done in the worktree `/home/user/scoutbox-agent` of
`youneshh1992/scoutbox` on the branch `feat/sqlite-schema`, created from
`fix/identity-hardening` at `0f01df7`. That branch descends from `main` at `66c095c`, which is
the commit the architecture review examined (`design/agent-finance` and `main` point at the
same commit; `main` was fast-forwarded on 9 October 2026). The commits between the review's
baseline and this work are:

| Commit    | Content                                                                                  |
|-----------|------------------------------------------------------------------------------------------|
| `4701c98` | Architecture rules in `CLAUDE.md` (trunk, feature freeze, repository layer, no new `db.x`) |
| `3fe242b` | Identity holes closed: login no longer accepts self-asserted roles, test IdP refused outside dev, `trust proxy` configurable |
| `0f01df7` | Relational data layer foundation: `repositories/database.mjs`, migration `0001_org_users`, staff accounts live in `org_users` |

The working tree carried no uncommitted changes from anyone else at the start of this task
(`git status` clean on `fix/identity-hardening`). No checkout was reset, no baseline was
switched, and the approved Player, Pro, Grassroots and Agent interfaces are untouched. The
other worktrees (`/home/user/scoutbox` on `claude/desktop-project-migration-wyk3ec`,
`-vivid`, `-grassroots`, `-pro`) were left as they were.

---

## 2. Storage today, and the review's claims checked against the code

### 2.1 How persistence works on this branch (FACT)

- `scoutbox-server/store.mjs` opens `DATA_DIR/scoutbox.db` with `node:sqlite`
  (`DatabaseSync`), sets `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON`
  (`store.mjs:59-60`), and keeps two tables: `collections(name TEXT PRIMARY KEY, value TEXT)`
  and `meta(key, value)` holding `idCounter`, `savedAt` and, since the S1 correction, the
  save revision `saveSeq` (advanced by every save; the shadow's freshness key) and the
  shadow's counts-only summary (`shadowSaveSeq`, `shadowProjectedAt`, `shadowSummary`).
- The whole in-memory `db` object is the database. `save()` serialises every collection to
  JSON and upserts it as one row (`store.mjs:63`, one `INSERT ... ON CONFLICT` per
  collection, in one transaction). `persist()` debounces 2 s (`server.mjs:145-155`);
  `persistNow()` writes synchronously and is called from many paths, including minting an id
  (`server.mjs:581`) and broadcasting a chat message (`server.mjs:521` via `broadcast`).
- Boot order (`server.mjs:115-235`): `buildSeed()` → `loadSnapshot()` replaces the seed when a
  snapshot exists → `runMigrations()` (`m182/migrations.mjs`, `SCHEMA_VERSION 2308`) →
  `attachDataLayer()` → `integrityReport()` → `db.x ??= []` normalisation → module
  registration → listen. The integrity report moved after the data layer at S3: it reads
  `db.orgs`, which is a table-backed view from the cutover on, so taken earlier it would
  have called every Room an orphan on every boot after the cutover (found by the server
  battery, regression test in `testOrgs.mjs`). The same ordering constraint holds for any
  future `m182` blob migration that would read `users`, `sessions` or `orgs`: those
  collections are empty placeholders until `attachDataLayer()` runs (the existing steps
  that read them are recorded and never re-run).
- Ids are `${prefix}-${++idCounter}` from one global counter persisted in `meta`
  (`server.mjs:579-583`); seed rows use natural ids (`org-eastport`, `pl-adeyemi`), migration
  backfills use `${prefix}-mig2305-<b36>-<seq>`.
- On a fresh boot with no snapshot, production starts with the seed (demo) data.
- `storeContract.mjs` names 136 collections: 55 guaranteed by migrations, 81 by module boot
  code. A fresh boot has 135 JSON blobs plus one real table, `org_users` (migration 0001).

### 2.2 Review claims, verified

| Review claim (section)                                                     | Verdict | Evidence on this branch |
|----------------------------------------------------------------------------|---------|-------------------------|
| All data in one in-memory object; SQLite used as a file (1)                | TRUE    | `store.mjs:59-110`; `collections(name, value)` |
| Every save writes everything; chat send calls `persistNow()` (1)           | TRUE    | `store.mjs save()`; `server.mjs:521` broadcast → `persistNow()` after `postMessage` (`server.mjs:884-915`) |
| Unbounded growth, e.g. profile views appended to the ledger (1)            | TRUE    | `ledgerAppend` `server.mjs:595-602`; ledger is never pruned; `exposureEvents` capped at 50k, `sourceChanges` at 20k, most audit arrays uncapped |
| No indexes; session lookup scans the sessions array (1)                    | TRUE at review; FIXED by S2 | was `sessionFor` (`db.sessions.find`); now `sessions.byToken` → `WHERE token_hash = ?` on the primary key (`repositories/sessions.mjs`) |
| ~130 collections created with `db.x ??= []`, untyped nested records (1)    | TRUE    | 136 in `storeContract.mjs`; `server.mjs:202-235` and each module's `migrateMxx` |
| Migration registry migrates JSON shapes, not tables (1)                    | TRUE    | `m182/migrations.mjs:83-622`; now complemented by `repositories/database.mjs` which migrates tables |
| Fresh install starts with seeded demo data (1)                             | TRUE    | `server.mjs:115` `buildSeed()`; plan step S13 separates production init from demo seeding |
| `GET /org/players` builds a view of every player, no pagination (2)        | TRUE    | `server.mjs:1890` region (full `db.players` filter + sort) |
| `scryptSync` on the main thread; 20 MB JSON bodies; CV module in JS (2)    | TRUE    | `adapters.mjs:19-23`; `server.mjs:305`; `m22/` |
| Shared org password with self-asserted role (5)                            | FIXED   | `3fe242b`: credentialed orgs refuse unknown staff (`STAFF_NOT_PROVISIONED`), roles are never taken from the request |
| SSO test IdP secret defaulted and registered in production (5)             | FIXED   | `3fe242b`: random per-boot secret, routes refused outside dev, `TEST_IDP_IN_PRODUCTION` boot refusal |
| `trust proxy` not set (5)                                                   | FIXED   | `3fe242b`: `httpTrust.mjs`, `SCOUTBOX_TRUST_PROXY`, capability `proxy_trust` |
| Identity verification always approves (5)                                   | TRUE    | `adapters.mjs:130-149` returns `approved: true` whatever the key; out of scope here (schema records provenance so a real provider can be plugged in, §9.5) |
| Session tokens stored in plain text (5)                                     | TRUE at review; FIXED by S2 | was `createSession` storing the 48-hex token in the blob; now `sessions.create` stores `sha256(token)` only and returns the token once; the blob is retired by migration `0003` (plan S2 states the remaining *physical* remnants: free pages until `VACUUM`, WAL until checkpoint, pre-S2 backups) |
| Responses filter by blocklist (`playerViewForOrg`) (6)                      | TRUE    | `server.mjs:1052` spreads the record then deletes fields; the schema cannot fix this, the repository layer's row-to-view mapping (S4) is where the allowlist goes |
| No request validation library (6)                                           | TRUE    | `optText`/`reqText` helpers; STRICT tables and CHECK constraints give the storage layer its own validation |

---

## 3. Inventory: every persistent collection and where it goes

Classes used below: **persistent** (business data, migrated to tables), **audit**
(append-only, never deleted with its subject), **derived** (recomputed on read, never
stored), **temporary** (short-lived, expires or is swept), **demo/catalogue** (seeded
constants or demo-only rows), **in-memory** (lost on restart by design), **dead** (declared
but never written). "Step" is the plan step that cuts the collection over
(`sqlite-migration-plan.md`); "File" is the DDL file under `docs/architecture/sql/`.

Nothing in this inventory disappears silently: every collection and every nested array or
object is either a table, a column, a named `*_json` column with a reason, a derived value
with the derivation named, or an explicitly dropped dead field. The per-field mapping is in
the header comment above each `CREATE TABLE` in the DDL files; this table is the index to
them.

### 3.1 Top-level collections (136, from `storeContract.mjs CONTRACT_STORES`)

| Collection | Class | File | Table(s) | Step |
|---|---|---|---|---|
| `users` | persistent | 01 | `org_users` (LIVE since migration 0001) | S0 done |
| `orgs` | persistent | 01 (+04, 05) | `orgs`; nested `tactical` → `org_tactical_setups/roles/role_criteria/windows`, `squad[]` → `org_squad_members`, `lookingFor[]` → `org_looking_for`, `federationCheck` → `org_federation_checks` (04); `verification.domains[]` → `org_verified_domains` (05); `verification.revokedAt/orgType` → columns on `orgs`; `agencySettings` → 06 | **S3 done** (live; scalars and composites are columns, the nested facets ride in `orgs.facets_json` until S9/S10/S11; blob retired by migration `0004`) |
| `guardians` | persistent | 01 | `guardians` (LIVE since migration 0005; `coGuardians[]`, `emailCode` and unknown fields in `facets_json`); `childIds[]` → `guardian_children` (LIVE) | **S4a done** (S4b: lifecycle, after O1) |
| `players` | persistent | 01 | `players` (scalars, `stats`, `medical.shared/conditionStatus`, `notificationPrefs`, `programme.track/startedAt`, `location`); `seasonHistory[]`, `badges[]`, `drills[]`, `attendance[]`, `timeline[]`, `media[]` (+`media[].tags` → `player_media_tags`), `medical.records[]`, `drillResults[]`, `activityLog[]`, `externalIds[]`, `programme.completed[]` → twelve `player_*` tables; `trialReports[]` derived (copy of `trials.report`) | S4 (scalars, shadow since S1), S5 (sub-records) |
| `sessions` | temporary | 01 | `sessions` (token stored as `token_hash`) | **S2 done** (live; blob retired by migration `0003`) |
| `requests` | persistent | 02 | `recruitment_requests`, `request_trial_slots`; `keys` → `idempotency_keys` | S8 |
| `trials` | persistent | 02 | `trials`, `trial_schedule_sessions`, `trial_session_evidence`, `trial_schedule_revisions`, `trial_attendance`, `trial_reminders`, `trial_day_staff`, `trial_day_consents`, `trial_day_checkins`, `trial_day_status_events`, `trial_reports` (the one copy; `players[].trialReports` is derived from it), `trial_history`; `keys` → `idempotency_keys` | S8 |
| `recruitmentCases` | persistent | 02 | `recruitment_cases` (room columns), `case_tags`, `case_assignments`, `case_tasks`, `case_approvals`, `case_history`, `case_request_links`, `case_trial_links`, `case_decision_drafts`, `case_transaction_handoffs`, `case_budget_scenarios`, `case_budget_lines`, `case_budget_fx_assumptions`, `case_budget_actuals` | S8 |
| `roomComments` | persistent | 02 | `room_comments`, `room_comment_mentions` | S8 |
| `roomDecisions` | audit | 02 | `room_decisions`, `room_decision_evidence_refs` (`snapshot` → `snapshot_id`, the copy is not stored twice) | S8 |
| `roomSnapshots` | audit | 02 | `room_snapshots`, `room_snapshot_source_refs` | S8 |
| `roomEvidenceState` | persistent | 02 | `room_evidence_states` | S8 |
| `recruitmentContacts` | persistent | 02 | `recruitment_contacts`, `contact_attempts`, `contact_history` | S8 |
| `recruitmentOffers` | persistent | 02 | `recruitment_offers`, `offer_revisions`, `offer_revision_documents`, `offer_responses`, `offer_read_receipts`, `offer_history` | S8 |
| `signingPackages` | persistent | 02 | `signing_packages`, `signing_revisions`, `signing_documents`, `signing_revision_parties`, `signing_history` | S8 |
| `signings` | persistent | 02 | `signings`, `signing_parties` (single writer `recordCompletedSigning`; `firstQualifyingInteraction` → ledger id, at, type) | S8 |
| `followUps` | persistent | 02 | `follow_ups` (UNIQUE signing + milestone) | S8 |
| `outcomeReports` | persistent | 02 | `outcome_reports`, `outcome_report_confirmations` (UNIQUE follow_up_id) | S8 |
| `channels` | persistent | 03 | `channels`; `messages[]` → `messages`, `attachment` → `message_attachments`; `readBy` → columns; `orgUserIdForNotify` dead | S7 |
| `notifications` | persistent | 03 | `notifications` (`actionRequired` → flag + columns) | S7 |
| `notificationPrefs` | persistent | 03 | `notification_prefs`, `notification_pref_categories` | S7 |
| `dispatches` | persistent | 03 | `dispatches`, `dispatch_attempts` | S7 |
| `outbox` | audit | 03 | `outbox` (two writer shapes unified) | S7 |
| `pushLog` | audit | 03 | `push_log` | S7 |
| `pushTokens` | persistent | 03 | `push_tokens` (token kept plain: it is the delivery address) | S7 |
| `blocks` | persistent (safeguarding) | 03 | `blocks` | S6 |
| `reports` | audit (safeguarding) | 03 | `reports` | S6 |
| `moderationLog` | audit (safeguarding) | 03 | `moderation_log` | S6 |
| `orgNotes` | persistent | 03 | `org_notes` | S6 |
| `ledger` | audit | 03 | `ledger` | S6 |
| `opsEvents` | audit | 03 | `ops_events` | S6 |
| `sourceChanges` | audit | 03 | `source_changes` | S6 |
| `emailChallenges` | temporary | 03 | `email_challenges` (`code_hash`) | S6 |
| `pairingCodes` | temporary | 03 | `pairing_codes` (`code_hash`) | S6 |
| `idvQueue` | audit (verification provenance) | 03 | `idv_queue` | S6 |
| `evidence` | persistent | 04 | `evidence`, `evidence_media`, `evidence_disputes`, `evidence_history` | S9 |
| `coachAffiliations` | persistent | 04 | `coach_affiliations`, `coach_affiliations_history` | S9 |
| `squadInvites` | persistent | 04 | `squad_invites` | S9 |
| `assessmentTemplates` | persistent | 04 | `assessment_templates` (PK `id, version`), `assessment_template_attributes` | S9 |
| `assessments` | persistent | 04 | `assessments`, `assessment_ratings`, `assessment_rating_evidence_refs`, `assessment_history`; `attributesSnapshot` derived from the immutable template version | S9 |
| `videoSegments` | persistent | 04 | `video_segments` | S9 |
| `playlists` | persistent | 04 | `playlists`, `playlist_segments` | S9 |
| `vacancies` | persistent | 04 | `vacancies` | S9 |
| `opportunities` | persistent | 04 | `opportunities`, `opportunity_training_slots` | S9 |
| `applications` | persistent | 04 | `applications`, `applications_history` | S9 |
| `campaigns` | persistent | 04 | `campaigns` | S9 |
| `campaignSubmissions` | persistent | 04 | `campaign_submissions`, `campaign_submission_attempts` | S9 |
| `playerPrefs` | persistent (private) | 04 | `player_prefs`, `player_pref_slots` (created on GET today) | S9 |
| `verClaims` | persistent | 05 | `ver_claims`, `ver_claim_history` (expected empty), `ver_claim_evidence` | S10 |
| `verEvents` | audit | 05 | `ver_events` | S10 |
| `verEvidence` | persistent | 05 | `ver_evidence`, `ver_claim_evidence` | S10 |
| `verTokens` | temporary | 05 | `ver_tokens` (hash already) | S10 |
| `verAdmins` | persistent | 05 | `ver_admins` | S10 |
| `verRootTransfers` | persistent | 05 | `ver_root_transfers` | S10 |
| `verRootRequests` | persistent | 05 | `ver_root_requests`, `ver_root_request_evidence` | S10 |
| `verDisputes` | persistent | 05 | `ver_disputes` | S10 |
| `verReferences` | persistent (versioned) | 05 | `ver_references` | S10 |
| `verPlayerInvites` | persistent | 05 | `ver_player_invites` | S10 |
| `verConflicts` | persistent | 05 | `ver_conflicts` | S10 |
| `verDomainRequests` | persistent | 05 | `ver_domain_requests` | S10 |
| `verMigrated` | audit (object) | 05 | `ver_migrations` | S10 |
| `passportPrefs` | persistent | 05 | `passport_prefs`, `passport_position_history`, `passport_public_selections` | S10 |
| `passportCareerEntries` | persistent | 05 | `passport_career_entries` | S10 |
| `passportAchievements` | persistent | 05 | `passport_achievements` | S10 |
| `passportShares` | temporary | 05 | `passport_shares` (`token_hash` already) | S10 |
| `passportCorrections` | persistent | 05 | `passport_corrections` | S10 |
| `transitionCases` | persistent | 05 | `transition_cases`, `transition_case_pack_items`, `transition_case_recipients`, `transition_case_history` | S10 |
| `representations` | persistent (legacy, no live creator) | 05 | `representations`, `representation_history` | S10 |
| `vouches` | persistent | 05 | `vouches` (`code_hash`) | S10 |
| `agentProfiles` | persistent | 06 | `agent_profiles`, `agent_profile_declared_jurisdictions`, `agent_profile_facets`, `agent_profile_history` | S11 |
| `agencyAffiliations` | persistent | 06 | `agency_affiliations`, `agency_affiliation_tiers`, `agency_affiliation_history` | S11 |
| `representationAgreements` | persistent | 06 | `representation_agreements`, `agreement_scopes`, `agreement_policy_versions`, `agreement_documents` (no writer today), `agreement_opportunity_shares`, `agreement_history`; `orgs.agencySettings` → `org_agency_settings`, `org_agency_jurisdictions` | S11 |
| `tsReviewers` | persistent | 06 | `ts_reviewers` (`secret_hash`), `ts_reviewer_history` | S11 |
| `jurisdictionPolicies` | persistent (dual control) | 06 | `jurisdiction_policies`, `jurisdiction_policy_publishers`, `jurisdiction_policy_rules`, `jurisdiction_policy_rule_sources`, `jurisdiction_policy_rule_overrides`, `jurisdiction_policy_history` | S11 |
| `regulatoryReviews` | persistent | 06 | `regulatory_reviews`, `regulatory_review_reasons`, `regulatory_review_policy_versions`, `regulatory_review_evidence_refs`, `regulatory_review_history` | S11 |
| `regulatoryConsents` | audit (append-only) | 06 | `regulatory_consents`, `regulatory_consent_regarding`, `regulatory_consent_policy_versions`, `regulatory_consent_rule_ids`, `regulatory_consent_revocations` (the `kind:'revocation'` rows), `regulatory_consent_history` | S11 |
| `complianceContexts` | persistent | 06 | `compliance_contexts`, `compliance_context_jurisdictions`, `compliance_context_parties`, `compliance_context_representations`, `compliance_context_resolved_facts`, `compliance_evaluations` (append-only, id `<ctx>#<n>`), `compliance_evaluation_reasons`, `compliance_evaluation_consents_outstanding`, `compliance_evaluation_policy_versions`, `compliance_context_history`; `otherServices[]`/`interests[]` never written, not migrated | S11 |
| `agentTransactions` | persistent | 06 | `agent_transactions`, `agent_transaction_jurisdictions`, `agent_transaction_compliance_policy_versions`, `agent_transaction_compliance_reason_codes`, `agent_transaction_consent_requirements`, `transaction_parties`, `transaction_party_history`, `transaction_notes`, `transaction_linked_threads`, `transaction_terms_versions`, `transaction_history` | S11 |
| `transactionRepresentations` | persistent | 06 | `transaction_representations`, `transaction_representation_scopes`, `transaction_representation_jurisdictions`, `transaction_representation_history` | S11 |
| `transactionDocuments` | persistent | 06 | `transaction_documents`, `transaction_document_history` | S11 |
| `devObjectives` | persistent | 07 | `dev_objectives` + items, item evidence, progress, shares, reassessments | S12 |
| `drillGuidance` | catalogue (seeded from DRILLS) | 07 | `drill_guidance` | S12 |
| `boxCamPrefs` | persistent (consent) | 07 | `box_cam_prefs` | S12 |
| `boxChallenges` | persistent (2 seeded on boot) | 07 | `box_challenges` | S12 |
| `boxChallengeEntries` | persistent | 07 | `box_challenge_entries` | S12 |
| `boxAssignments` | persistent | 07 | `box_assignments` | S12 |
| `boxSessions` | persistent | 07 | `box_sessions`, `box_session_challenge_entries`, `box_session_integrity_events`; `obs` retained as `obs_json` (write-once stream) ; `nonce` → `nonce_hash` | S12 |
| `boxSessionEvents` | dead (declared, never written) | 07 | none; recorded in the file's trailing block | dropped at S14 |
| `boxCamDisputes` | persistent | 07 | `box_cam_disputes` | S12 |
| `combineRequests` | persistent | 07 | `combine_requests`, `combine_request_protocols` | S12 |
| `combineAttempts` | persistent | 07 | `combine_attempts` | S12 |
| `boxCamCvResults` | persistent (immutable) | 07 | `box_cam_cv_results` (PK `provider_session_id`) | S12 |
| `recruitmentBriefs` | persistent | 07 | `recruitment_briefs`, `recruitment_brief_criteria_values`, `recruitment_briefs_history` | S12 |
| `nobodyMissedReviews` | persistent | 07 | `nobody_missed_reviews`, `nobody_missed_reviews_history` | S12 |
| `secondLookItems` | persistent | 07 | `second_look_items`, `second_look_item_fingerprints`, `second_look_items_history` | S12 |
| `dynamicWatchlists` | persistent | 07 | `dynamic_watchlists`, `watchlist_criteria`, `watchlist_memberships`, `dynamic_watchlists_history` | S12 |
| `watchlistHistory` | audit | 07 | `watchlist_membership_events` | S12 |
| `developmentPlans` | persistent | 07 | `development_plans`, `development_plan_shares`, `development_plans_history` | S12 |
| `developmentGoals` | persistent | 07 | `development_goals`, `development_goals_history` | S12 |
| `developmentActions` | persistent | 07 | `development_actions`, `development_actions_history` | S12 |
| `developmentEvidenceLinks` | persistent | 07 | `development_evidence_links` | S12 |
| `developmentReviews` | audit (append-only) | 07 | `development_reviews`, `development_review_goal_snapshots`, `development_reviews_history` | S12 |
| `exposureEvents` | audit (capped 50k) | 07 | `exposure_events` | S12 |
| `reviewLater` | persistent | 07 | `review_later` | S12 |
| `evidenceSuggestions` | persistent (written on GET) | 07 | `evidence_suggestions` | S12 |
| `calibrationSessions` | persistent | 07 | `calibration_sessions`, `_participants`, `_submissions`, `_ratings`, `_notes` | S12 |
| `fixtures` | persistent | 07 | `fixtures` (read-time union with `fr-`/`tr-` synthetic rows stays derived) | S12 |
| `coveragePlans` | persistent | 07 | `coverage_plans` | S12 |
| `coverageAssignments` | persistent | 07 | `coverage_assignments`, `_targets`, `_assessments` | S12 |
| `apiKeys` | persistent | 08 | `api_keys`, `api_key_scopes` | S13 |
| `webhookEndpoints` | persistent | 08 | `webhook_endpoints`, `webhook_endpoint_events` | S13 |
| `webhookDeliveries` | audit (never pruned) | 08 | `webhook_deliveries`, `webhook_delivery_attempts` | S13 |
| `orgInvites` | temporary | 08 | `org_invites` (`token_hash`) | S13 |
| `ssoConfigs` | persistent | 08 | `sso_configs` | S13 |
| `ssoStates` | temporary | 08 | `sso_states` (`state_hash`, `nonce_hash`) | S13 |
| `supportTickets` | persistent | 08 | `support_tickets`, `support_ticket_replies`, `support_ticket_refs` | S13 |
| `supportAccessGrants` | persistent | 08 | `support_access_grants`, `support_access_log` | S13 |
| `importBatches` | persistent (PII rows) | 08 | `import_batches`, `import_batch_rows`, `import_batches_history`, `import_batch_created_prospects` | S13 |
| `prospects` | persistent | 08 | `prospects` | S13 |
| `identityReviews` | persistent | 08 | `identity_reviews` | S13 |
| `groups` | persistent | 08 | `groups`, `group_admins`, `group_members`, `group_pending_invites`, `group_shared_templates`, `group_programmes` | S13 |
| `groupGrants` | persistent | 08 | `group_grants`, `group_grant_recipients` | S13 |
| `uploadSessions` | temporary | 08 | `upload_sessions`, `upload_session_chunks` (chunk bytes stay on disk) | S13 |
| `savedSearches` | persistent | 08 | `saved_searches` | S13 |
| `openTrials` | persistent | 08 | `open_trials`, `open_trial_positions`, `open_trial_registrations` | S13 |
| `matchdays` | persistent | 08 | `matchdays`, `matchday_players` | S13 |
| `friendlies` | persistent | 08 | `friendlies`, `friendly_responses` | S13 |
| `invoices` | persistent (money) | 08 | `invoices` (`amount_minor`, `currency`) | S13 |
| `plans` | catalogue | 08 | `plans` (`price_per_month_minor`, `currency 'GBP'`) | S13 |
| `archetypes` | catalogue | 08 | `archetypes` | S13 |
| `reputationSeed` | demo | 08 | `reputation_seed`; production init leaves it empty | S13 |
| `deliveryCallbacksSeen` | temporary (string[], capped 5k) | 08 | `delivery_callbacks_seen` (+ `seen_at` for the cap) | S13 |
| `deliveryCentreSince` | persistent (number) | 08 | `ops_settings` key `delivery_centre_since` | S13 |
| `deliveryFailInject` | operational/test (object) | 08 | `ops_settings` keys `delivery_fail_inject.<channel>` | S13 |
| `secrets` | secret (`mediaSign`) | 08 | no table: moves to env `MEDIA_SECRET`, not copied by the migration | S13 |
| `mediaBlobs` | dead (legacy, always `{}` after boot, `server.mjs:246-249`) | 01 | none; dropped at S14 | — |

Not stores (per `storeContract.mjs NOT_A_STORE`): `schema` (the snapshot migration
registry's own record; superseded by `data_migrations` at S14) and `json` (a filename).

Coverage check (run for the acceptance review): every one of the 136 names in
`storeContract.mjs CONTRACT_STORES` appears as a row of the table above, and every table
in the DDL files carries a `-- source:` header naming the collection or nested path it
comes from, so the mapping is closed in both directions.

### 3.2 Nested structures created dynamically

These are the nested arrays and objects that modules add to other modules' records at
runtime. Each has a destination in the DDL headers:

- `orgs.tactical`, `orgs.squad[]`, `orgs.lookingFor[]`, `orgs.federationCheck` (04);
  `orgs.verification` (05 and `orgs` columns); `orgs.agencySettings` (06);
  `orgs.mfaRequiredForLeads` (01 column).
- `players.media[].captions`, `players.media[].capturedBy/boxSessionId` (01 `player_media`);
  `players.externalIds[]`, `players.footballCategory`, `players.level`, `players.attendance[]`
  trial check-ins (01).
- `trials.day{staff,consents,arrival,emergency,collection,checkins,statusEvents}`,
  `trials.schedule{sessions[],revisions[]}`, `trials.attendance[]`, `trials.history[]`,
  `trials.keys{}`, `trials.reminders{}` (02).
- `requests.trialDetails.slots[]`, `requests.trialDetails.private`, `requests.keys` (02).
- `recruitmentCases.room`, `.tasks[]`, `.decisionDraft`, `.transactionHandoff`, `.links`,
  `.budget.scenarios[]`, `.history[]` (02).
- `users.mfa` (`org_users.mfa_json`, S0; `secretB32` is plain inside it — OPEN, §11).
- `representationAgreements.opportunityShares[]` (06, written by m27).
- Every `history[]` array (two shapes: `{id aud-*, at, byKind, byId, byName, action, detail}`
  from `m12/shared.mjs:70` and `{id, at, action, by{kind,...}, detail}` from m23+) becomes a
  `<table>_history` table with the conventions in §4.
- Every `keys{...}` idempotency structure (`{key,fp}`, lists, or maps keyed by action) becomes
  rows in the shared `idempotency_keys` table (02), primary key `(owner_table, owner_id, act,
  key)` with `fp`, `at`, `ref_id` and `actor_id`.

### 3.3 Derived, temporary and in-memory state (not tables)

Each DDL file ends with a `-- not tables:` block naming what is deliberately not persisted.
In summary: read-time values (age, trust score, tiers, streaks, next actions,
`safeguardingCertified`, `guardianManaged`, distances, similar players, insights, funnels,
reputation, channel `closed`, notification targets, expired/stale statuses, journey
projections, passport revisions and timelines, watchlist membership, plan progress, combine
projections); code registries (DRILLS, PROVIDERS, COMBINE_PROTOCOLS, CLAIM_TYPES, POSITIONS,
notification categories, moderation rules, retry ladders, catalogues of plans and archetypes
are seeded into tables but defined in code); in-memory runtime state (SSE clients, tickets
and replay log, rate-limit buckets, MFA attempt guards, CV provider sessions, metrics
counters, fault rules, the save timer, the integrity report).

---

## 4. Conventions

All DECISIONs, applied in every DDL file (`scratchpad/ddl-conventions.md` was the brief given
to each file's author; the rules are restated here so the document is self-contained).

- **Engine and tables.** SQLite 3.51.2 through `node:sqlite` on Node 22.22.2. Every table is
  `STRICT` (types are enforced: a TEXT value in an INTEGER column is refused). No triggers, no
  views in the DDL; behaviour lives in repositories.
- **Naming.** snake_case; tables are plural nouns of the entity; foreign-key columns end in
  `_id`; child tables of an aggregate are prefixed with the parent (`player_media`,
  `trial_attendance`); history tables are `<table>_history`.
- **Ids.** Existing string ids are preserved exactly as `id TEXT PRIMARY KEY`. There is no
  integer autoincrement anywhere: clients store ids, guardians log in by id, and the Player app
  keys its token map by id. Rows without an id today get either a natural composite primary
  key or a new `<prefix>-<n>` id minted from the same global counter by the migration; each
  header says which. The global counter stays in `meta.idCounter` until S14 and then moves to
  its own row; prefixes that collide today (`rep-` for reports and trial reports and
  representation agreements, `md-` for medical records and matchdays, `dsp-` for disputes and
  dispatches, `att-` for attendance and campaign attempts, `rev-` for room evidence state and
  the `rev` field) are harmless because ids are unique per table, but the plan keeps them
  unique globally too.
- **Timestamps.** Instants are INTEGER epoch milliseconds named `*_at` (source fields named
  `ts` become `created_at`/`occurred_at`, said in the mapping). Date-only values are TEXT
  `YYYY-MM-DD` named `*_date` with `CHECK (length(x) = 10)`. Source fields that accept raw
  user input in several formats (passport `from`/`to`/`when`) are kept as `*_raw` or
  `*_raw_json` without a format CHECK and normalised at read, exactly as today.
- **Booleans.** INTEGER `CHECK (x IN (0,1))`, `NOT NULL DEFAULT 0` where the code treats
  absence as false; nullable where the code distinguishes "unknown" (medical `cleared`,
  `guardianApproved`, `schoolHoursMute`).
- **Statuses and enums.** TEXT with `CHECK (x IN (...))` listing exactly the values the code
  writes. Values that are only ever derived (`expired`, `EXPIRED`, `STALE`, `not_recorded`)
  are not in the CHECK and stay derived. Open sets (`ledger.type`, `notifications.type`,
  `moderation_log.context_kind`) have no CHECK and the observed values are listed in the
  header.
- **Money.** INTEGER minor units named `*_minor` plus `currency TEXT CHECK (length = 3)`.
  `invoices.amount` (major units today) is converted by `× 100`; `plans.pricePerMonthGBP`
  becomes `price_per_month_minor` with `currency 'GBP'`. Budget scenarios already use minor
  units.
- **JSON columns.** TEXT named `*_json` with `CHECK (json_valid(x))`. Each one is justified in
  its header as either free-form by design (arbitrary tags, provider traces, rule parameters,
  `detail` of audit entries) or deferred normalisation with the step that normalises it
  (`box_sessions.obs_json`, `assessments.context_extra_json`). Nothing structured that is
  queried stays in JSON.
- **References.** Real references are `REFERENCES parent(id)` with an explicit `ON DELETE`:
  `CASCADE` for rows owned by the parent, `RESTRICT` for audit rows that must outlive their
  subject, `SET NULL` where the code tolerates a missing target. Polymorphic references are a
  `(x_kind, x_id)` pair with a CHECK on the kind and no FK, with the possible targets named.
  Denormalised name snapshots (`org_name`, `player_name`, `scout_name`, `by_name`) are kept as
  columns marked `-- snapshot`; they are what the product shows after the subject is deleted.
- **History.** `<table>_history (id TEXT PRIMARY KEY, <parent>_id, at, by_kind, by_id,
  by_name, action, detail_json)`; append-only; ids minted where the source has none.
- **Soft delete.** Nullable INTEGER `removed_at`, `revoked_at`, `withdrawn_at`,
  `cancelled_at`, `subject_removed_at`, `deleted_at` columns; hard deletes only for rows the
  code hard-deletes today and that nothing references.
- **Secrets.** No plain secret column. Session tokens, invite tokens, pairing and e-mail
  codes, SSO state and nonce, box session nonces, vouch codes, reviewer secrets are `*_hash`
  (sha256 hex; the header says the plain value was stored before). Passwords are
  `password_hash` (scrypt string). Two deliberate exceptions, both marked: `push_tokens.token`
  (the Expo delivery address; hashing makes it unusable) and `webhook_endpoints.secret`
  (needed to sign outgoing bodies; OPEN: encrypt at rest).
- **Headers.** Every table carries `-- source`, `-- owner/writer … lifecycle`, a `-- mapping`
  line for every source field, and `-- notes` (uniqueness, privacy, retention, defects).

---

## 5. Schema by domain

The executable definitions are the eight files in `docs/architecture/sql/`, 320 tables and
388 indexes in all, executed in lexical order into one database by
`scoutbox-server/scripts/testSchemaDdl.mjs` (every table STRICT except `org_users`, which is
documented exactly as migration 0001 created it and is rebuilt STRICT at S3; every foreign
key target present; every table with a primary key; every index on an existing table; and
the migration-0001/0002 tables equal in columns and indexes to the documented DDL). Result on
this branch: 13 checks passed.

| File | Domain | Tables | Plan step |
|---|---|---|---|
| `01_identity.sql` | organisations, staff, guardians, players and their sub-records, sessions | 18 | S0–S5 |
| `02_recruitment.sql` | requests, trials, cases and rooms, decisions, contacts, offers, signing packages, signings, follow-ups, idempotency keys | 55 | S8 |
| `03_messaging_safety_audit.sql` | channels and messages, notifications, delivery, push, blocks, reports, moderation, notes, ledger, ops events, source changes, one-time codes, IDV queue | 21 | S6, S7 |
| `04_scouting_assessment.sql` | evidence, coach affiliations, squads and tactical setups, assessment templates and assessments, video, vacancies, opportunities, applications, campaigns, player preferences | 33 | S9 |
| `05_verification_passport.sql` | verification claims, events, evidence, tokens, admins, root requests, disputes, references, invites, conflicts, domains; passport; transition cases; representations; vouches | 31 | S10 |
| `06_agent_compliance_transactions.sql` | agent profiles, affiliations, representation agreements, reviewers, jurisdiction policies, regulatory reviews and consents, compliance contexts, agent transactions, documents | 61 | S11 |
| `07_development_boxcam_discovery.sql` | development objectives and plans, drill guidance, Box Cam sessions, challenges, assignments, disputes, Combine, CV results, briefs, Nobody Missed, Second Look, watchlists, exposure, review-later, suggestions, calibration, fixtures, coverage | 57 | S12 |
| `08_operations_integrations.sql` | API keys, webhooks, invites, SSO, support, imports and prospects, groups, uploads, saved searches, open trials, matchdays, friendlies, invoices, plans, archetypes, reputation seed, callback ids, operational settings | 44 | S13 |

### 5.0 What is implemented, what is proposed, what waits on a decision

| State | Tables | Where |
|---|---|---|
| **Implemented, live** (a repository owns the rows; the blob is gone) | 3: `org_users` (rebuilt STRICT with `org_id REFERENCES orgs(id)` and `json_valid` CHECKs in `0004`), `sessions` (`token_hash` only; the table was created by `0002` and became live, with the legacy blob imported and retired, in `0003`), `orgs` (created live by `0004` with the legacy blob imported and retired; scalars and the `location` / `federationRef` composites are columns, the nested facets ride in `facets_json` until S9–S11) | migrations `0001` (S0), `0003` (S2), `0004` (S3) |
| **Implemented, live** (S4a) | 3 + 1: `guardians`, `players` (scalars and the split composites as columns; since S5 only unknown fields and shape metadata in `facets_json`), `guardian_children` (derived from `childIds`, roles per side) — created live by `0005_core_identity_live` with the two blobs imported through the reviewed preflight and retired; `media_deletions` (the crash-safe media-removal queue, `0006`, file 08). The S1 shadow is retired | migrations `0005`, `0006` (S4a) |
| **Implemented, live** (S5) | 12: the `player_*` sub-record tables (`player_season_history`, `player_badges`, `player_drills`, `player_attendance`, `player_timeline`, `player_media`, `player_media_tags`, `player_medical_records`, `player_drill_results`, `player_activity_log`, `player_external_ids`, `player_programme_completions`), created by `0007_player_subrecords` from the S4a rows through the one mapping; `trialReports` is derived from the trials, not a table ([`s5-player-subrecords.md`](./s5-player-subrecords.md)) | migration `0007` (S5) |
| **Proposed** (executable DDL, asserted to load, no migration, no repository) | 302 | files 02–08 |
| Of the proposed, **blocked on an unresolved decision** | file 02 (55 tables): every `player_id` lacks a foreign key until the tombstone decision O1 is implemented at S4, and `org_id RESTRICT` depends on O2; `webhook_endpoints.secret` and `org_users.mfa_json` depend on O3; `exposure_events`, `webhook_deliveries`, `dispatches`, `outbox` retention depends on O4; `assessments` depends on O6; `second_look_items` key on O7; `representations` on O8; `agent_profile_facets.member_association` sentinel on O10 | §10, §12 |

Counts: 19 implemented, 302 proposed, of which 55 (file 02) cannot be cut over until S4b
has shipped the tombstone (O1) and the file has been amended with the player foreign keys
(plan S8 "Depends on"). The remaining open questions change columns or retention rules,
not table boundaries.

### 5.0.1 Why 320 tables and 388 indexes

The counts follow from the inventory, not from a design preference. Classified by the
`-- source:` header of each `CREATE TABLE` (script run on the files; `scratchpad` evidence
reproduced here):

| Origin of the table | Count | Rule that produced it |
|---|---|---|
| A top-level collection in `storeContract.mjs` (136 stores, minus `secrets`, `mediaBlobs`, `boxSessionEvents`, `deliveryFailInject`/`deliveryCentreSince` → `ops_settings`, `verMigrated` → `ver_migrations`, and the two `orgs` facets that moved to their own files) | 129 | one table per persistent collection (§4) |
| A nested array or object inside a record (`players[].media[]`, `trials.schedule.sessions[]`, `groups[].memberOrgIds[]`, …) | 155 | §4: nothing structured that is queried stays in JSON; arrays of rows become child tables with the parent's id; string arrays that are filtered or joined become `(parent_id, value)` tables |
| An append-only `history[]` array | 35 | §4: every history array becomes `<table>_history` |
| Shared infrastructure (`idempotency_keys`) | 1 | one implementation of the replay/conflict rule |

The child-table count is the large one. It is driven by the model, not the schema: a
player record alone carries twelve arrays; a trial carries schedule, revisions, attendance,
day staff, consents, check-ins, status events, reminders and history; agent transactions
carry parties, notes, threads and term versions. Keeping these as JSON would have been
fewer tables and would have kept every per-element query a full-record parse, which is
the defect the migration exists to remove. Where an array is read only whole and never
queried per element, it *was* kept as `*_json` with a stated reason (`box_sessions.obs_json`,
`reason_codes_json`, `trace_json`, rule parameters), so the count is the lower one that the
read patterns allow.

Indexes (388 = 65 unique + 323 plain):

| Kind | Count | Evidence required |
|---|---|---|
| Unique indexes for natural keys the code enforces by scanning today (one open room per org/player, one pending request, one entry per challenge/player, fingerprints, token hashes, e-mail) | 65 | the scan the code performs is cited in the table header; the index is marked "enforced by code today" or "NEW, validate against data first" |
| Plain indexes for a read the code performs (lookup by org, by player, by status, by token hash, sweep by due time) | 323 | the header's `-- notes:` names the reader (file:line) for the index |

The index headers are the evidence and they are uneven: files 02, 04 and 06 cite the
reader for every index in the table header (46, 8 and 70 comment lines naming indexes),
files 01, 03, 05, 07 and 08 cite most and leave some as "natural key of the child table"
(the `(parent_id)` index on a child table, which every parent read needs). No index was
added without a named read or a natural key; none was removed for this review. The test
only proves the indexes reference existing tables; whether an index earns its write cost
is settled per domain at its step with the perf harness (plan C.7), which is why the plan
says "indexes are reviewed by hand at the step".

### 5.1 Identity (file 01) — entities, ownership, lifecycle

```
orgs ──< org_users ──< sessions (kind='org')
  │
  └──< org_squad_members, org_tactical_*, org_looking_for, org_federation_checks (04)
guardians ──< guardian_children >── players ──< player_* (12 sub-record tables)
  │  └─ co_guardian_of → guardians (self)          └─ guardian_id → guardians (SET NULL)
  └──< sessions (kind='guardian')                  └──< sessions (kind='player')
```

- **`orgs`** — one row per club or agency (live since S3, `repositories/orgs.mjs`). Owner:
  registration (`server.mjs`, `orgs.insert`), T&S org creation (`m14/review.mjs`,
  `orgs.insert`), org settings routes, admin verification / credentials / suspension and
  the `m13` security route (`orgs.update`). Lifecycle: `suspended` flag; no deletion route
  exists today and S3 adds none (O2, below). CHECKs: `type IN (club, agency)`, `level IS
  NULL OR level IN (pro, academy, agency, grassroots)` (nullable since S3: the T&S creation
  path writes `level: null`, which the S1 shadow could not hold), `plan IN (Pro, Academy,
  Agency, Grassroots)`, `(lat IS NULL) = (lng IS NULL)`, every flag `IN (0,1)`,
  `json_valid(facets_json)`. Columns: identity (`id, name, type, level, plan, country`), the
  `location` composite (`city, lat, lng`), the `federationRef` composite (`federation,
  federation_registration_id`), flags (`trusted_partner, verified, verified_domain,
  safeguarding_contract_signed, suspended, email_domain, email_domain_verified,
  mfa_required_for_leads`), `password_hash` (the org's shared bootstrap password, still used
  for the one-time bootstrap path after `3fe242b`), `created_at`, and `facets_json`
  (**transitional**): the nested `tactical`, `squad`, `lookingFor`, `federationCheck`,
  `agencySettings`, the whole `verification` object and any field the schema does not know,
  plus the record's key order, explicit nulls and composite presence so the record the
  server sees is byte-for-byte the record it wrote. `verification_revoked_at` and
  `verification_org_type` are **derived mirrors** of `verification.revokedAt` /
  `verification.orgType` written at every flush; nothing reads them until S10 moves the
  verification object out of the facets, when they become authoritative. Index
  `orgs_type_level`. Three guarantees the repository enforces (review corrections after
  `0851d38`): a facet change is tracked as persisted only once the save that flushed it
  **committed** (the store reports commit or rollback to the repository's save hook, so a
  rolled-back flush is repeated by the next save); the column-backed composites are served
  through a guard that refuses nested assignment, deletion and property definition, so the
  view can never hold a `location` or `federationRef` the table does not; and the
  first-installation import is explicit state, `meta.orgsInit` (`pending` only for a database
  nothing was ever saved to, `done` otherwise), never a row count — an empty cut-over table
  stays authoritative and `attach()` imports nothing.
- **`org_users`** — staff accounts (live since S0; rebuilt STRICT at S3). Columns: `id, org_id,
  name, role, email, sso_subject, created_at, removed_at, removed_by, provenance, mfa_json,
  delivery_prefs_json, extra_json`; `org_id TEXT NOT NULL REFERENCES orgs(id)` (enforced:
  a staff row cannot name a missing organisation and an organisation with staff cannot be
  deleted), `json_valid` CHECKs on the three JSON columns; indexes on `org_id`, `(org_id,
  lower(name))`, `(org_id, email)`, `sso_subject`. The S3 rebuild creates `org_users_s3`,
  copies every row, drops the old table and renames the new one — in that order, because
  SQLite ≥ 3.26 rewrites `REFERENCES` in *other* tables on `RENAME`, so renaming the old
  table first would have redirected `sessions.org_user_id` to the temporary name; the
  migration asserts afterwards that `sessions` still references `org_users` and that every
  staff row was copied, and `PRAGMA foreign_key_check` must be empty before the commit.
- **`guardians`** — adults who manage minors. Unique e-mail, case-insensitive, by index
  (`guardians_email ON guardians (lower(email))`): the code enforces it only on signup and the
  co-guardian path bypasses it today (`server.mjs:1576-1590`), so the shadow report shows
  whether real data contains duplicates before S4 enforces them. `email_code_hash` replaces
  the plain `emailCode`. `co_guardian_of` is a self-reference, `SET NULL` on delete.
  `deleted_at` is the tombstone (§10).
- **`players`** — one row per player profile, adult or minor. Scalars as columns (position,
  foot and availability enums are CHECKed; `birth_date` is a 10-character date); the
  `stats`, `medical` summary, notification preferences, programme and location objects are
  flattened to prefixed columns; `guardian_id` → `guardians` (`SET NULL`); `deleted_at`
  tombstone. Indexes: `players_guardian`, `players_created_at` (newest-first lists, signup
  cut-offs), `players_search (country, position, availability)` (the `/org/players` filter),
  `players_level`.
- **`guardian_children`** — the link the code keeps by hand in two places
  (`players.guardianId` and `guardians.childIds[]`), with `role IN (primary, co)`. Primary key
  `(guardian_id, player_id)`, both `CASCADE`.
- **`sessions`** — `token_hash` is the primary key (sha256 of the bearer token), `sid` unique
  (media URL signing and logout-by-sid use it), `kind IN (player, guardian, org, ts_reviewer)`,
  `ref_id` (the account id), `org_user_id → org_users CASCADE` (required exactly when
  `kind = 'org'`, by CHECK), `via IN ('sso')`, `created_at`, `expires_at` (materialised from
  the TTL so expiry is a comparison, not a computation). Indexes `(kind, ref_id)` (revoke all
  of an account), `org_user_id`, `expires_at` (prune).
- **Player sub-records (S5, live since migration `0007`)** — `player_season_history`,
  `player_badges`, `player_drills`, `player_attendance` (with `lat/lng`, `verified`,
  `corroborated_by`), `player_timeline`, `player_media` (+ `player_media_tags (media_id, tag,
  count, position)`), `player_medical_records` (medical privacy §9.4), `player_drill_results`,
  `player_activity_log`, `player_external_ids`, `player_programme_completions`. All `CASCADE`
  from `players`; every table carries `position` (the array index) and the item tables an
  `extra_json` for unknown item fields and shape metadata; rows without a client-visible id are
  keyed by `(player_id, position)` — nothing is minted. `trialReports` is derived from
  `trials[].report`, not stored. Decisions and the reconciliation with the data the routes
  accept: [`s5-player-subrecords.md`](./s5-player-subrecords.md).

### 5.2 Recruitment (file 02, 55 tables, 79 indexes)

One recruitment case per (org, player) room; requests, trials, contacts, offers and signing
packages hang off the case and the org. `room_decisions` and `room_snapshots` are
append-only; a decision stores only its `snapshot_id` rather than a second copy of the
snapshot. Idempotency keys from every `keys{...}` structure (requests, trials, contacts,
decision drafts, handoffs, offers, packages; agent transactions and consents in file 06 use
the same table) move to one `idempotency_keys` table so the one rule ("the same key with the
same fingerprint returns the same result, a different fingerprint is a conflict") has one
implementation. The file adds the partial unique indexes the code enforces by scanning today
(one open room per org/player, one pending request per org/player/type, one open trial per
case, one live offer per case, one live and one completed package per offer, one signing per
package and per offer) and lists the dead fields it drops (`trials.keys.accept.key`, always
null; `trials.blockedBy`; `signings.cancelledAt/revokedAt/voidedAt`, read but never written).
Raw client values that are not validated today (`case.deadline`, legacy `dueAt`,
`trial_day_staff.check.expiresAt`) are kept verbatim in `*_raw` columns and parsed on read, as
now. The `trials.day.emergency` contact stays restricted to the trial day's staff reads.

### 5.3 Messaging, safety and audit (file 03)

Channels are 1:1 with a request; messages are children, oldest-first by `(channel_id,
created_at)` with a unique `(channel_id, sender_kind, sender_id, client_msg_id)` for the
client idempotency key. Notifications are addressed to `(audience_kind, audience_id)`.
Safeguarding rows (`blocks`, `reports`, `moderation_log`) and audit rows (`ledger`,
`ops_events`, `source_changes`, `idv_queue`, `org_notes`) reference players with `ON DELETE
RESTRICT`: they must outlive the subject, which is why §10 makes player deletion a tombstone.
One-time codes (`email_challenges`, `pairing_codes`) are stored hashed.

### 5.4 Scouting and assessment (file 04)

Evidence (player-owned, with media links, disputes and history), coach affiliations, squad
membership and tactical setups (org-owned, moved out of the `orgs` record), assessment
templates versioned by `(id, version)` with the template's attributes as rows, assessments
with one rating row per attribute, vacancies, opportunities and applications, campaigns and
submissions, and private player preferences. Org-private records that name a player
(`assessments`, `applications`, `campaign_submissions`) use `RESTRICT` with a nullable
`player_name`; player-owned rows `CASCADE`.

### 5.5 Verification and passport (file 05)

`ver_claims` (subject polymorphic: user or org), `ver_events` (append-only audit of every
claim change with actor and attribution), `ver_evidence` with the `ver_claim_evidence`
junction, hashed `ver_tokens`, org verification admins and root transfers, root requests,
disputes, versioned references, player invites, conflicts of interest, domain requests, and
the migration record. Passport tables keep what the player asserts (positions, career,
achievements, public selections) separately from what is confirmed (`confirmation_*`
columns with provenance). `passport_shares` keep a token hash with expiry and revocation.

### 5.6 Agent, compliance and transactions (file 06, 61 tables, 56 indexes)

Agent profiles with verification facets (state, reference, member association, provenance
with reviewer and review id), agency affiliations with tiers, representation agreements
(scope, term, exclusivity, status, termination and dispute fields, opportunity shares as a
child table), T&S reviewers (`secret_hash`), jurisdiction policies with dual-control
publication, regulatory reviews, append-only regulatory consents (revocations in their own
table, one per consent), compliance contexts with parties, representations and append-only
evaluations, agent transactions with parties, notes, linked threads and terms versions,
transaction representations and documents. Uniqueness that the code enforces on an
*effective* status (one proposed/active/disputed agreement per agent and client, one open
review per subject) is deliberately not an index, because a stored-status index would refuse
rows the code allows after expiry; partial unique indexes exist only where stored state is
the rule (one active affiliation, one live party role, the context↔transaction 1:1). The
file records the defect that compliance routes read `req.org.settings.jurisdictions`, which
is never written, instead of `agencySettings` (`m25/index.mjs:254, 370`).

### 5.7 Development, Box Cam and discovery (file 07)

Development objectives and plans (goals, actions, evidence links, append-only reviews with
goal snapshots), drill guidance, Box Cam preferences (the consent gate for sharing
development activity), challenges and entries, assignments, sessions (nonce hashed,
observation stream retained as `obs_json` until normalised), disputes and integrity events,
Combine requests and attempts, immutable CV results, recruitment briefs with criteria values,
Nobody Missed reviews, Second Look items with fingerprints, dynamic watchlists with criteria,
memberships and membership events, exposure events, review-later, evidence suggestions,
calibration sessions, fixtures, coverage plans and assignments.

### 5.8 Operations and integrations (file 08)

API keys (hashed) with scopes, webhook endpoints and deliveries with attempts, org invites
(hashed token), SSO configs and hashed SSO states, support tickets and access grants with
access logs, import batches with their PII rows, prospects and identity reviews, groups
with admins, members, invites, shared templates and programmes, group grants, upload
sessions (chunks on disk), saved searches, open trials with positions and registrations,
matchdays, friendlies, invoices (minor units), plan and archetype catalogues, the demo-only
reputation seed, processed callback ids, and a key/value `ops_settings` table for the two
persisted operational singletons.

---

## 6. Indexes

Every index is tied to a read the code performs today; the justification is in the header
of its table. The ones that change behaviour at scale:

| Index | Replaces |
|---|---|
| `sessions (token_hash)` primary key | linear scan of every session on every authenticated request (`sessionFor`, `server.mjs:661`); measured 115 µs → 3.4 µs at 20k sessions (`scripts/dataLayerPerf.mjs`) |
| `sessions (kind, ref_id)`, `(org_user_id)`, `(expires_at)` | full scans on logout-all, staff revocation and prune |
| `guardians (lower(email))` unique | `find` by lower-cased e-mail at login and signup, and the uniqueness the code enforces by hand |
| `players (guardian_id)` | `filter` per guardian child list |
| `players (country, position, availability)`, `(created_at)`, `(level)` | the `/org/players` filter and sort (`server.mjs:1890`) and signup cut-offs; pagination (S4) uses `created_at, id` |
| `ledger (player_id, org_id, occurred_at)`, `(org_id, type)` | reputation and attribution scans |
| `notifications (audience_kind, audience_id, read, occurred_at)` | unread list and coalescing window |
| `messages (channel_id, created_at)` + unique client key | thread reads and idempotent sends |
| `recruitment_requests (org_id, player_id, type, status)` | the one-pending rule |
| `blocks (player_id, org_id)` | `isBlocked` in every visibility path |
| `reports (target_org_id, urgent, status)` | `safeguardingCertified` on every org view |
| `ver_claims (subject_kind, subject_id)`, `(authority_id)` partial | the in-memory claim index rebuilt on boot |
| `second_look_items (org_id, room_id, decision_id)` unique, `nobody_missed_reviews (org_id, brief_id, player_id)` unique, `watchlist_membership_events (fingerprint)` unique | natural keys the code enforces by scanning |
| `api_keys (key_hash)` unique, `ver_tokens (hash)` unique, `passport_shares (token_hash)` unique, `org_invites (token_hash)`, `pairing_codes (code_hash)`, `email_challenges (org_id)` | token lookups |

Indexes without a read pattern were not created; the DDL test only checks that each index
names an existing table, the review of necessity is by hand (§5.0.1 gives the counts by
kind and where the evidence for each sits).

---

## 7. Engine configuration

DECISIONs, some already in force:

- **WAL.** `PRAGMA journal_mode = WAL` is set once on open (`store.mjs:59`); WAL is persistent
  in the file. Keep it: readers never block the single writer, and the checkpoint runs
  automatically. Backups copy `scoutbox.db` together with `-wal` and `-shm`, or use
  `VACUUM INTO` (plan step S13 adds an admin backup that does exactly that).
- **Foreign keys on every connection.** `PRAGMA foreign_keys = ON` is per connection, not per
  file. The server has exactly one connection (`store.mjs`), set on open. Every tool that opens
  the file (`openStore` in persistence suites, the DDL test, the perf harness) sets it too,
  and `testCoreSchema.mjs` asserts that cascades actually fire so a missing pragma is caught.
- **Busy timeout.** DONE at S2: `store.mjs` sets `PRAGMA busy_timeout = 5000` on every
  connection it opens, so a save that meets a writer in another connection or process waits
  up to five seconds instead of failing with `SQLITE_BUSY`. `testSessions.mjs` proves it with
  a second process holding a write transaction, and proves the failure without the pragma.
- **Prepared statements.** Every repository prepares its statements once at construction
  (`repositories/users.mjs`, `repositories/sessions.mjs`, `repositories/orgs.mjs`,
  `repositories/identity.mjs`, `repositories/mediaDeletions.mjs`) and binds parameters by name;
  no SQL is built from strings at request time. Column lists come from frozen constants, never
  from input.
- **Transaction boundaries.** Each HTTP mutation that touches more than one table runs inside
  one `transaction(sqlite, fn)` (`repositories/database.mjs`), opened by the route's service
  function, so a failure leaves nothing half-written; reads run outside transactions. During
  the migration an operation that writes repository rows and blob collections together runs
  inside `store.unitOfWork` (one transaction, memory restored on failure); the ordinary save
  transaction flushes pending facets and writes the blobs. The S1 shadow projection and its
  savepoint are retired (S4a). Table migrations each run in their own transaction
  (`runDataMigrations`) and abort the boot on failure with the file untouched.
- **Synchronous mode.** Default (`FULL` in WAL mode is `NORMAL` for the WAL file). Keep the
  default; the durability guarantee is "committed transactions survive a process crash", and
  a power loss can lose the last checkpointed transactions only in `NORMAL`. OPEN: set
  `synchronous = FULL` for production if the host's storage warrants it; measure first.
- **STRICT and `json_valid`** need SQLite ≥ 3.37 and ≥ 3.38 respectively; 3.51.2 ships with
  Node 22.22.2 (checked with `select sqlite_version()`). `node:sqlite` is still flagged
  experimental in Node 22 (a warning on import); the API used (`DatabaseSync`, `prepare`,
  `exec`, `run/get/all`) has been stable across 22.x. Required versions: Node ≥ 22.13 (first
  release with the `node:sqlite` surface used here), SQLite ≥ 3.38. CI and the Dockerfile pin
  Node 22.
- **Encoding.** All text is UTF-8 (SQLite default). Ids and e-mails are compared with
  `lower()` where the code compares case-insensitively.

---

## 8. Schema versioning

- **Two registries, one order.** `m182/migrations.mjs` (`SCHEMA_VERSION 2308`) migrates the
  JSON snapshot in memory and records itself in `db.schema`. `repositories/database.mjs`
  migrates tables with SQL and records each migration id in the `data_migrations (id TEXT
  PRIMARY KEY, applied_at INTEGER)` table in the database itself, so a restored file carries
  its own history. Order at boot: snapshot migrations first, then table migrations
  (`attachDataLayer`), then modules.
- **Migration modules** live in `scoutbox-server/repositories/migrations/NNNN_name.mjs` and
  export `{ id, note, up(sqlite) }`. Ids sort lexically; a migration runs once, in a
  transaction, and a failure aborts the boot without modifying the file. There is no `down`:
  rollback is restore-from-backup (§ plan, every step records its rollback).
- **Applied today:** `0001_org_users` (S0), `0002_core_identity_shadow` (S1), `0003_sessions_live` (S2), `0004_orgs_live` (S3), `0005_core_identity_live` and `0006_media_deletions` (S4a), `0007_player_subrecords` (S5).
- **Rule.** The DDL in `docs/architecture/sql/` is the design; the migration files are what
  runs. `testSchemaDdl.mjs` asserts the two agree for every table a migration has created, so
  the document cannot drift from the code without a failing test.
- **Snapshot version after cutover.** When a collection becomes table-backed, the blob is
  deleted from `collections` on the next save and the snapshot migration steps that touched it
  become no-ops (they already tolerate a repository view). At S14 `db.schema` is replaced by
  `data_migrations` and `meta.idCounter` moves to a `counters` table.

---

## 9. Tenancy, guardianship and safeguarding in the schema

- **9.1 Tenant isolation.** Every org-owned row carries `org_id NOT NULL REFERENCES orgs(id)`
  and the repositories' queries always take the caller's org id as a parameter (never the
  record's). Rows that are shared between orgs by design (group grants, transition case
  recipients, development plan shares, friendlies responses, offers to a player) have an
  explicit recipient table rather than a visibility flag. Player-owned rows carry
  `player_id`; what an org may see of them is decided by the visibility rules in
  `domain.mjs` (`orgCanSee`), which stay in code and are called by the repository's
  org-facing read, built from an allowlist of columns (not the stored row).
- **9.2 Organisation ownership.** `org_users.org_id` → `orgs`; a session for staff requires
  `org_user_id` (CHECK on `sessions`), so a session can never be attributed to an org
  without a staff row; revoking a staff member cascades to their sessions.
- **9.3 Guardian–child.** `guardian_children (guardian_id, player_id, role)` is the single
  link; `players.guardian_id` is kept as the primary guardian for the read paths that use it
  and must equal the `role = 'primary'` row (S4 enforces this in the repository and the shadow
  report flags disagreement today). Age is derived from `birth_date` and the country threshold
  (`domain.mjs isAdult`) at read, never stored, so aging-up needs no data change; what the
  aging-up routine does (remove the child link from the primary guardian) becomes one delete
  in `guardian_children`. Minor accounts have no `password_hash` (nullable) and no e-mail.
- **9.4 Consent and medical privacy.** `players.medical_shared` is the consent flag that
  gates `player_medical_records` for orgs; records are in their own table so an org-facing
  read can leave the table unjoined rather than delete fields from a spread. Box Cam
  sharing consent is `box_cam_prefs.share_development_activity`; development plan visibility
  is `development_plans.visibility` plus `development_plan_shares`; passport sharing is
  `passport_shares` with expiry and revocation; agent opportunity sharing is
  `representation_agreement_opportunity_shares`. Each is a column or a table, not a derived
  string.
- **9.5 Verification provenance.** Verification is never a cached boolean: `ver_claims` rows
  with status, method, authority kind and id, `valid_from/valid_until`, and `ver_events` with
  actor and attribution for every change; `idv_queue` keeps who verified a guardian with which
  provider and reference; `passport_achievements` keep `confirmation_*` provenance;
  `agent_profile_facets` keep `provenance_kind/provider/reviewer_id/review_id/at`. The legacy
  `orgs.verified` boolean stays as a column marked legacy and is derived from claims at S10.
- **9.6 Agencies and minors.** `representation_agreements.is_regulatory_minor` is a CHECKed
  constant `0` today (agreements for minors are refused at the route) and
  `ver_claims`/`agent_profile_facets` carry `minors_authorisation`; the rule that agencies
  never see minors is a read rule in `domain.mjs` and stays there. The schema gives it the
  inputs (`birth_date`, `orgs.type`) without exposing `birth_date` to orgs (the org-facing
  allowlist excludes it).
- **9.7 Audit attribution.** Every history and audit table has `by_kind`, `by_id`, `by_name`
  (snapshot) and `at`; `ledger` has `(actor_kind, actor_id, actor_name)`; `ver_events`
  `actor_kind/actor_id/actor_name/actor_org_id/attribution`. Inconsistencies in what the code
  records today (org id instead of user id, `'admin'` literals, guardian withdrawal audited
  as `player`) are preserved as data and listed as defects in the headers; the schema does not
  guess a different actor.

---

## 10. Retention and deletion

FACT today: `deletePlayerData` (`server.mjs:3978-4023`) hard-deletes the player row, their
sessions, channels and messages, player notifications and pairing codes, removes
`childIds` entries, tombstones requests and trials (`subjectRemovedAt`), redacts cases,
assessments, contacts and open-trial registrations, runs the m24–m29 hooks, and leaves names
in `signings`, `vouches`, `invoices`, `matchdays.playerIds`, squad entries, and all audit
rows (`ledger`, `blocks`, `reports`, `orgNotes`, `moderationLog`, `outbox`, `pushLog`,
`pushTokens`, `idvQueue`); it leaves orphans in every m13–m22 store. There is no guardian or
org deletion route. Backups (`m13/enterprise.mjs:428`) copy the snapshot including tokens and
`secrets.mediaSign` although the manifest says they contain no secrets.

DECISIONs:

- **Personal-data deletion is a tombstone plus erasure, not a row delete.** `players` and
  `guardians` keep their row with `deleted_at` set and every personal column nulled or
  replaced (`name` → `'Deleted player'`, `birth_date` kept only as year-less `'0000-01-01'`?
  OPEN §12 — alternative: keep `birth_date` because minors' rules need it until the audit
  retention ends). Owned sub-records (`player_*`, media files, evidence media, prefs,
  sessions, pairing codes, channels and messages, player-audience notifications) are deleted
  (`CASCADE` or explicit). Audit and safeguarding rows (`ledger`, `blocks`, `reports`,
  `moderation_log`, `org_notes`, `idv_queue`, `source_changes`, `ver_events`, room decisions
  and snapshots, signings, invoices) keep their `player_id` foreign key (`RESTRICT`) pointing
  at the tombstone; name snapshots on those rows are replaced by the tombstone name in the
  same transaction. This is the only way the `RESTRICT` audit references and the deletion
  obligation can both hold.
- **What survives deletion is listed, not implied.** Each DDL header's `lifecycle` line says
  whether the table is erased, cascaded or retained on subject deletion; the plan's S4
  acceptance test enumerates them and fails if a new table lacks the statement.
- **One unresolved relational-integrity point (OPEN O9), with its resolving step.** File 02
  (recruitment) carries no foreign key on any `player_id` because its author designed
  against today's hard delete (a `SET NULL` FK would erase the id the tombstone exists
  for); files 03–08 reference `players(id)` with `RESTRICT` or `CASCADE` (48 references),
  which presumes the tombstone above. Both are documented in the file headers. This is not
  a finished design: the recruitment domain cannot be cut over while its player references
  are unenforced. Resolution, in order: O1 is decided by the Founder before S4; **S4**
  implements the tombstone (`players.deleted_at`, erasure of personal columns, the
  per-table lifecycle statements); **S8a** amends `02_recruitment.sql` to add `REFERENCES
  players(id) ON DELETE RESTRICT` on every `player_id` and ships it in migration
  `0010_recruitment`. Until S8a lands, the file 02 DDL is proposed, not accepted.
- **Guardian and org deletion.** New routes in S4 (guardian: only when no non-deleted child
  remains) and S3 (org: `suspended` plus `deleted_at`; staff and sessions cascade; recruitment
  rows keep the org tombstone). OPEN: the Founder's policy on org deletion with open
  recruitment cases.
- **Retention windows (new, enforced by sweeps in the repository, not by the schema):**
  `sessions` deleted after `expires_at`; `email_challenges`, `pairing_codes`, `sso_states`,
  `ver_tokens`, `org_invites`, `upload_sessions` deleted after expiry (today `verTokens`,
  `ssoStates` and `webhookDeliveries` are never pruned); `exposure_events` 50k cap →
  time-based (OPEN: 180 days); `delivery_callbacks_seen` FIFO 5k; `webhook_deliveries` and
  `dispatches` OPEN (90 days proposed); `ledger`, `moderation_log`, `reports`, `ver_events`
  never pruned.
- **Backups** (S13) use `VACUUM INTO` of the whole file, so they contain exactly what the
  tables contain: hashed tokens, no `mediaSign` (moved to env), passwords hashed. The manifest
  statement becomes true.

---

## 11. Existing security weaknesses the survey found (explicit list)

All FACT on this branch unless marked fixed. The schema addresses the storage half of each;
the route and response half is named with its plan step.

1. **Plain-text secrets in the snapshot and in backups:** session tokens
   (`server.mjs:650`), guardian `emailCode` (`1244`), `emailChallenges.code` (`3024`),
   `pairingCodes.code` (`3766`), `vouches.code` (`3692`), `orgInvites.token`
   (`m13/enterprise.mjs:80`), `ssoStates.state/nonce` (`274`), `boxSessions.nonce`
   (`m16/sessions.mjs:89`), `users.mfa.secretB32` (`m13/mfa`), `webhookEndpoints.secret`,
   `secrets.mediaSign` (`server.mjs:345`), and one-time codes inside `outbox.text`. Schema:
   `*_hash` columns everywhere except push tokens and webhook secrets (OPEN: encrypt at rest
   with a key from env); `mediaSign` leaves the database; `outbox.text` retention OPEN.
2. **Unsalted sha256 for API keys, verification tokens and share tokens** (`m13/imports.mjs`,
   `m14/shared.mjs:299`, `m15/sharing.mjs:31`). Acceptable for 32-byte random tokens; not for
   6-character codes (`email_challenges`, `pairing_codes`, ~30 bits): the header notes it and
   S6 adds attempt limits per code.
3. **Blocklist response filtering** (`playerViewForOrg`, `server.mjs:1052`): attendance GPS,
   notification preferences, other orgs' trial-report notes, drill results and `createdAt`
   leak to clubs today. S4 builds the org-facing player view from an allowlist of columns.
4. **`/admin/guardians` returns raw rows including password hashes and e-mail codes**
   (`server.mjs:4219`). S4 replaces it with a repository view.
5. **Guardian e-mail uniqueness bypass on the co-guardian path** (`server.mjs:1576-1590`).
   The unique index makes it impossible; the shadow report shows existing duplicates first.
6. **Coach affiliation matched by display name** (`m12/passport.mjs:328`): `coach_affiliations`
   keeps `coach_user_id` and the name as a snapshot; S9 makes the id the key.
7. **Backups include secrets despite the manifest** (`m13/enterprise.mjs:454`). Fixed by 1
   and S13.
8. **Deletion leaves names and orphans** (§10). Fixed by the tombstone design at S4 and the
   per-table lifecycle statements.
9. **Writes on GET** (`playerPrefs`, `evidenceSuggestions`, `passportPrefs`, `boxCamPrefs`,
   Second Look reconcile, watchlist reconcile). The schema allows lazy rows; the plan moves
   each lazy insert into the repository's read with an explicit upsert so a GET cannot fail
   on a write constraint.
10. **Org-staff push tokens are registered with the session's `kind:'org'` and `refId:org id`
    but the sender filters on `org_user`** (`adapters.mjs:111`): staff never receive pushes.
    Defect recorded in `push_tokens` header; S7 registers tokens by `(audience_kind,
    audience_id)`.
11. **Ledger truncation on signing rollback** (`m29/index.mjs:618`) is the one violation of
    append-only; S8's `signings` repository compensates with a reversal row instead.
12. **Admin IDV toggle updates only the first `idvQueue` row per guardian**
    (`server.mjs:4226`); `idv_queue` keeps every row and S6 updates by id.
13. **Identity verification provider always approves** (`adapters.mjs:130-149`). Out of
    scope for the schema; `idv_queue.provider/reference/status` record what happened so a
    real provider's decision is auditable.
14. **Shared admin key** (`x-admin-key`), **no player e-mail** (no reset flow): identity
    model work, outside this document.

---

## 12. Facts, decisions, assumptions, open questions

**Facts** are marked throughout; the load-bearing ones: the blob store design (§2.1), the
136-collection contract, the single global id counter, the single SQLite connection, the
boot order, the deletion routine's behaviour, the review verification table (§2.2), the
measured costs (§ plan S1: blob save 8.9 ms at 1k players and 101.9 ms at 10k; full
re-projection of five tables 99 ms and 1120 ms).

**Decisions** (with reasons in place): STRICT tables; text ids preserved; epoch-ms instants
and 10-character dates; hashed tokens everywhere except push tokens and webhook secrets;
tombstone deletion with `RESTRICT` audit references; polymorphic references as kind/id pairs
without FK; history tables with minted ids; shared `idempotency_keys`; `mediaSign` to env;
`ops_settings` for the two operational singletons; `plans`/`archetypes` seeded from the code
catalogue; shadow-then-cutover per domain; no integer keys; no triggers or views.

**Assumptions**:

- A1. No production data exists yet beyond demo and test snapshots; migrations may therefore
  refuse (not silently fix) rows that violate the target constraints, and the shadow report
  is the tool that finds them before cutover. If a production snapshot exists, S2–S4 run
  their dry-run on a copy of it first (plan §backups).
- A2. Clients treat ids and tokens as opaque and never parse prefixes (frontend survey,
  `scratchpad/survey-frontend.md`): hashing tokens server-side keeps every existing client
  session valid.
- A3. The approved end-to-end suites are the behavioural specification; a domain is
  migrated when its suites pass unchanged apart from assertions that describe the old storage
  (47 of 48 server suites pass on this branch; the 2 failing checks in `m182E2E` are
  pre-existing client-source checks, identical on `main`).
- A4. One server process, one connection, for the whole migration period. Horizontal scaling
  is after S14.
- A5. Node 22 `node:sqlite` stays available in the deployment image (Dockerfile pins Node 22).

**Open questions** (for the Founder or a later step; none blocked S2 or S3):

- O1. Deletion: keep `birth_date` on the player tombstone (needed for minor rules while audit
  rows exist) or erase it? Proposed: keep year only.
- O2. Org deletion policy with open recruitment cases. **Deferred past S3 deliberately**: S3
  cut organisations over without a tombstone column and without a hard-delete path, because
  no route deletes an organisation today and the foreign key from `org_users` (and, from S8,
  from every recruitment table) makes the choice between `RESTRICT`, a tombstone that keeps
  open cases readable and a cascade a product decision, not a storage one. Until it is taken,
  `suspended` is the only lifecycle flag and the repository exposes no delete.
- O3. Encrypt `webhook_endpoints.secret` and `org_users.mfa_json` secrets at rest with an env
  key, or accept hashed-where-possible plus file permissions for beta?
- O4. Retention windows for `webhook_deliveries`, `dispatches`, `outbox`, `exposure_events`.
- O5. `synchronous = FULL` in production.
- O6. `assessments.attributesSnapshot`: derived from the immutable template version (chosen)
  or stored as JSON belt-and-braces?
- O7. Second Look natural key: the engine uses `(org, room, decision)`, the integrity check
  uses `(org, room)`; the schema enforces the engine's; the integrity check needs updating.
- O8. `representations` (legacy, creation closed with 410): migrate or archive as JSON?
  Proposed: migrate (it is small, and the shape is known from commit `e865531`).
- O9. Player foreign keys on the recruitment tables (file 02 has none; §10). Proposed: add
  `RESTRICT` references at S8, after the tombstone exists.
- O10. `agent_profile_facets.member_association` cannot be NULL in a STRICT composite primary
  key, so the FIFA-level facet is stored as `'INT'` (the vocabulary's code). Confirm with the
  compliance owner that `INT` is the right sentinel.

---

## 13. Sources

Code read for this design (line numbers refer to this branch): `scoutbox-server/server.mjs`
(boot 115–235, ids 579–583, sessions 639–669, player view 1052, requests 2068, players list
1890, deletion 3978–4023, admin 4219–4294), `store.mjs`, `seed.mjs`, `domain.mjs`,
`adapters.mjs`, `storeContract.mjs`, `m182/migrations.mjs`, `m12/*` (passport, scouting,
journeys, operations, shared), `m13/*` (shared, imports, enterprise, delivery, suitability,
insight, planning, groups, transitions, mfa), `m14/*`, `m15/*`, `m16/*`, `m17/*`, `m18/*`,
`m19/*`, `m21/*`, `m22/*`, `m23/*`, `m24/*`–`m29/*`, `repositories/*`, the frontend type
files (`scoutbox-club/src/api.ts`, `scoutbox-grassroots/src/api.ts`, `roomsApi.ts`,
`scoutbox-agent/src/api.ts`, `scoutbox-player/src/domain/types.ts`,
`scoutbox-player/src/httpClient.ts`), `OPERATIONS.md`, `AGENTS.md`, `CLAUDE.md`, and the
architecture review of 9 October 2026. The detailed survey notes that fed the DDL headers are
in the session scratchpad (`survey-core.md`, `survey-m12-m13.md`, `survey-m14-m17.md`,
`survey-m18-m22.md`, `survey-m23-m29.md`, `survey-frontend.md`); their conclusions are
carried in the DDL file headers so nothing depends on the scratchpad.
