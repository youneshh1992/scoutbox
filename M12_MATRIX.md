# Milestone 12 — Requirements matrix

Baseline verified 2026-09-07 on branch `claude/desktop-project-migration-wyk3ec`
at `8ea50e6` (working tree clean). Previously-reported work confirmed present in
code, not just in conversation history:

- **M11.1 connected-mode fixes** (`3aacb3a`): session-bound media signatures
  (`mediaSig(id,exp,sid)` server.mjs:194, re-check `sessionMayAccessMedia`
  :3358), SSE live re-authorisation + `resync` (:267–:305), credentialed org
  login (:1336), `DATA_DIR` test isolation, reseed archival.
- **Demo pipeline** (`8ea50e6`): `e2e/buildDemos.mjs` (badge + build id),
  `e2e/buildConnectedDemo.mjs` (three-app shared-simulation page).
- **Artifacts** (from this session's artifact registry): Player
  `b91499f1…`, Pro `34c738e4…`, Grassroots `d2b059f1…`, Admin (T&S)
  `4172504f…`, Launcher `0ce703f6-a5a9-4bc7-a85c-4af38a668105`, Connected
  `f86846c4…` — all republished 2026-09-05 at build 3aacb3a.
- Stack: Express + SQLite snapshot (`store.mjs`), bearer sessions, org users
  (`db.users`, per-individual accountability), guardian gates, `visibleToOrg`
  (agency wall, verified-clubs-only minors, grassroots level ceiling + 50 km
  fail-closed), moderation, ledger, SSE scoping, signed media.

Migration convention: `db.<collection> ??= []` after snapshot load — additive,
non-destructive, versioned by commit. New M12 collections follow it in
`m12/shared.mjs`.

| # | Feature | Current implementation (verified) | Missing behaviour → M12 build | Backend records + permissions | App screens | Tests | Status |
|---|---------|-----------------------------------|-------------------------------|------------------------------|-------------|-------|--------|
| 1 | Evidence passport | Stats self-edited; attendance w/ `corroboratedBy` (coach-signed); vouches (email-code refs); combine drill results marked "verified" by video presence — **overclaimed, audited in M12** | Evidence records w/ claim type, source, provenance tiers (self/coach-confirmed/club-assessed; independent modelled but no pathway sets it — honest), corrections/supersede, disputes, freshness, insufficient-evidence display; passport aggregation relabels legacy "verified" honestly | `db.evidence`; player/guardian create; org corroborate gated by `visibleToOrg`+blocks; admin disputes | Player Profile passport; Pro/Grassroots drawer; Admin disputes | m12E2E §1 | ✅ done |
| 2 | Structured assessments | Trial reports (fixed 6 fields) only | Versioned position templates w/ anchors, not-observed + confidence, states draft→submitted→published, server-enforced blind second opinion, comparison, published feedback separate from private notes | `db.assessmentTemplates`, `db.assessments`; org-scoped; blind rule server-side; publish → player/guardian | Pro Assessments screen; Grassroots simplified; Player feedback view | m12E2E §2 | ✅ done |
| 3 | Recruitment workspace | Requests/trials/signings exist; no case layer | Cases w/ stages, owner, assignments, tasks, approvals (lead-only), immutable history, restricted cases, staff removal revokes sessions+SSE+media | `db.recruitmentCases`; `user.removedAt` in `orgAuth`; lead = role-based | Pro Recruitment board; Grassroots simple flow | m12E2E §3 | ✅ done |
| 4 | Tactical fit | Grassroots `squadView` gap analysis (kept) | Formations/role definitions, vacancies, shadow squad, explainable rule-based matching (met/notMet/unknown + evidence; **no fabricated percentages**) | `org.tactical`, `db.vacancies`; org-scoped | Pro Squad Planner | m12E2E §4 | ✅ done |
| 5 | Opportunity board | Grassroots open days + radar | Structured opportunities w/ eligibility, adult + guardian applications, dedupe, server-side eligibility rejection, outcomes + reminders, open-day integration (no duplication) | `db.opportunities`, `db.applications`; guardian routing; 50 km preserved | Pro+Grassroots manage; Player/Guardian board | m12E2E §5 | ✅ done |
| 6 | Assessment campaigns | Combine drills w/ video-presence "verification" (**relabelled**) | Campaigns w/ drills+recording instructions+rubric+attempt policy, automated FILE checks distinct from human review, rejection reasons + resubmission; drill library recording guidance + coach-review status (default unreviewed, shown) | `db.campaigns`, `db.campaignSubmissions`; eligibility server-side | Pro/Grassroots manage+review; Player submit | m12E2E §6 | ✅ done |
| 7 | Video workspace | Film Room (clips, tags); no segments | Timestamped segments w/ labels/drawing refs, playlists, assessment deep links, org-private annotations, permission-checked source access, 15-min URL refresh (existing) | `db.videoSegments`, `db.playlists`; org visibility rules | Pro Video workspace + assessment links | m12E2E §7 | ✅ done |
| 8 | Development loop | Trial-report strength/focus notes shown | Objectives (≤2) from **published** feedback only, baseline+progress evidence, player/guardian-controlled sharing, reassessment request→outcome | `db.devObjectives`; consent gates; guardian for minors | Player/Guardian objectives; Pro/Grassroots follow-up | m12E2E §8 | ✅ done |
| 9 | Trial-day | Trials w/ date/venue/ICS/report deadline | Staff roster w/ check states (pending/reviewed/expired/rejected — **a filed ref is not a completed check**), event consent, arrival, restricted emergency contact, check-in→attendance (deduped), cancel/postpone, collection, safety pack, feedback escalation | trial.day sub-record; gates 409 before check-in; admin review queue | Pro/Grassroots trial mgmt; Player/Guardian safety pack; Admin checks | m12E2E §9 | ✅ done |
| 10 | Coach identity | Vouches (email code — identity NOT verified, now labelled) | Club-confirmed affiliations w/ role/dates/status, conflict-of-interest declaration, withdrawal history, revocation removes current privileges, restricted squad invitations w/ player/guardian approval | `db.coachAffiliations`, `db.squadInvites`; confirm gated by org | Grassroots Coaches; Admin review; Player/Guardian approvals | m12E2E §10 | ✅ done |
| 11 | Post-signing outcomes | Signings + Pathway Club (first involvement→progression) | 3/6/12-month persisted follow-ups (restart-safe, idempotent sweep), reported/confirmed/disputed/unknown, pathway "sustained" split, admin aggregates w/ n<3 suppression | `db.followUps`, `db.outcomeReports`; sweep on interval+boot | Pro/Grassroots outcomes; Player confirm; Admin report | m12E2E §11 | ✅ done |
| 12 | Access & inclusion | None of: resumable uploads, offline drafts, i18n, captions | Chunked resumable uploads (integrity, finalise, cleanup, no premature success), Pro offline assessment drafts (identity-scoped, conflict-safe), EN/FR for new screens + chrome (machine-translated, labelled), accessibility pass on new web screens, captions on instructional media, benchmark sample-size/method disclosure ("not enough evidence"), women's/girls' + men's/boys' categories on opportunities/roles, distance bands not addresses | `db.uploadSessions`, media `captions`; owner-scoped | All apps: settings, upload UI, drafts | m12E2E §12 | ✅ done |

Deliberately NOT implemented (would be fabrication): independent measurement
providers, computer-vision drill scoring, real background-check integrations,
professional translation review, native-device testing. Each is modelled as an
explicit pending state or absent claim — see final report §limitations.
