# Milestone 14 — Verification & Trust System: requirements matrix

Baseline: commit `08aa56b` (M13 complete). Baseline regressions before any M14 change:
unit **23 ✓** · apiE2E **129 ✓** · m12E2E **143 ✓** · m13E2E **212 ✓** · connectedE2E **43 ✓**
(Browser/live suites were green at this exact commit at M13 close-out and are re-run in full after M14.)

Existing verification-adjacent infrastructure M14 integrates with (never forks):
`org.verified` + `safeguardingContractSigned` (gates minor visibility via `visibleToOrg`),
org email-domain challenge (`/org/verification/email`), `federationRef` (grassroots),
guardian `emailVerified`/`idVerified` + IDV queue, `player.identityVerified`, M9 vouches,
F10 representation credentials, F11 delivery centre, F12 invites/MFA/SSO/audit/support,
DOB/country `isAdult` (NO new age system).

| § | Requirement | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|
| 0 | Baseline inspected + regressions recorded | this file | baseline run above | ✅ | — |
| 1–2 | Independent claims (12 types), not a boolean | `m14/shared.mjs` CLAIM_TYPES, claims store | m14E2E unit + V1/V15 | ✅ | — |
| 3 | Server-validated state machine (11 states + superseded) | `VALID_TRANSITIONS`, `applyTransition` | unit fixtures + security #4 | ✅ | — |
| 4 | Method recorded; document_submitted ≠ verified | claim.verificationMethod; method allowlist | V7/V14 | ✅ | — |
| 5 | Authority chain person→org→admin→relationship→role | `m14/organisations.mjs` confirm flow | V1 | ✅ | — |
| 6 | Root-org bootstrap: automated pre-checks then human review | `verRootRequests` + `preReview()` + T&S queue | V3/V4 | ✅ | First admin of an org without an existing authority is always human-reviewed (by design) |
| 7 | Work-email token challenge; domain control ≠ employment | `m14/organisations.mjs` email challenges | V1 + token suite V13 | ✅ | Email leaves via local fake transport only |
| 8 | Club Verification console (overview/requests/staff/domains/admins) | Pro+Grassroots `m14screens.tsx`; org routes | L1/L2 + spotchecks | ✅ | — |
| 9 | verification_viewer/reviewer/admin/root_admin, server-enforced; MFA for root ops | `verAdmins` + `verPermission()` | security #3/#9/#10 | ✅ | — |
| 10 | Claim data model w/ immutable significant events | `verClaims` + append-only `verEvents` | unit + V6 | ✅ | — |
| 11 | Append-only verification events with actor/correlation/before-after | `verEvent()` helper | m14E2E event assertions | ✅ | — |
| 12 | Evidence records w/ provenance, visibility, retention | `verEvidence` | V7 + cross-tenant #7 | ✅ | — |
| 13 | Licence: submitted / registry_match / manual_authority_confirmation; registry adapter | `m14/review.mjs` licence adapter | V7/V8 | ✅ | No production registry connected — all providers `not_configured` except local test fixture |
| 14 | Historical affiliation (validFrom/validUntil, current=false) | claim periods + `markDeparted` | V5/V15 | ✅ | — |
| 15 | Revocation propagates immediately, history kept | effective engine + revoke routes | V5/V10 + #15 | ✅ | — |
| 16 | Disputes: case, evidence kept, T&S queue, never silently gone | `verDisputes` + dispute routes | V6 | ✅ | — |
| 17 | Explicit conflict-of-interest declarations | `verConflicts` routes | m14E2E COI checks | ✅ | Declared only, never inferred |
| 18 | Coach references w/ provenance snapshot; guardian routing; no safeguarding bypass | `verReferences` | V16 + V9 | ✅ | — |
| 19 | Reference correction/supersession/withdrawal, never silent edit | reference versioning | V16 | ✅ | — |
| 20 | Squad invitations w/ acceptance, guardian flow, rate limits | `verPlayerInvites` | m14E2E invite checks | ✅ | — |
| 21 | Central badge system, provenance explanation, accessibility | server `badgesFor()` + per-app `VerificationBadge` | V14 + spotchecks | ✅ | — |
| 22 | Verification profile panel | clients + `GET /org/verification/me` | L1 + spotchecks | ✅ | — |
| 23 | T&S Verification section (queues, filters, case view, actions w/ reason) | admin routes + `m14tabs` | V4/V6 + L3/L5 | ✅ | — |
| 24 | Deterministic CAN_AUTO_COMPLETE vs REQUIRES_HUMAN_REVIEW + reason codes | `decideReview()` | unit fixtures + V3/V17 | ✅ | — |
| 25 | Automated pre-review engine (16 steps) | `preReview()` | V3 case packaging | ✅ | — |
| 26 | Deterministic risk signals, never labelled fraud | `riskFlags()` | unit + V3 | ✅ | — |
| 27 | Self-verification prohibited server-side | `assertNotSelf()` on every confirm path | V2 + #1/#10 | ✅ | — |
| 28 | Two-person control for high-risk ops | dual-approval on root transfer/domain replace | V18 | ✅ | — |
| 29 | Organisation lifecycle states | `org.verification.status` + effective engine | V11 | ✅ | — |
| 30 | Organisation types, audited category changes | root request orgType + audited change | m14E2E | ✅ | — |
| 31 | API per existing router conventions | `/org/verification/*`, `/admin/verification/*`, `/verification/public/*` | whole suite | ✅ | — |
| 32 | Explicit authorization on every route + isolation tests | `verPermission` + orgAuth/adminAuth | security #1–#18 | ✅ | — |
| 33 | Idempotency, stale/illegal transitions rejected predictably | `applyTransition` + 409s | #11/#12 double-approve | ✅ | — |
| 34 | Tokens: random, hashed at rest, expiring, single-use, purpose+address-bound | `mintToken`/`consumeToken` | V13 | ✅ | — |
| 35 | F11 delivery-centre notifications | `notify()` calls on every event | m14E2E notification checks | ✅ | Local fake transport only — nothing external |
| 36 | Expiry/reconfirmation policies + deterministic processor | `verificationSweep()` | expiry checks | ✅ | Scheduled infra beyond in-process sweep documented |
| 37 | Mark-as-left closes period, keeps history, kills powers, notifies, audits | `markDeparted` | V5 | ✅ | — |
| 38 | Visibility classes PUBLIC / ORG_INTERNAL / T&S / SUBJECT_ONLY | `verEvidence.visibility` + projectors | #7/#8 + V12 | ✅ | — |
| 39 | Retention classifications + documented boundary | `retention` field + docs | docs | ✅ | No global scheduled deletion engine exists — documented |
| 40 | File security (allowlist, size, hash, no exec, auth on read, `malware_scan: not_configured`) | evidence upload route | #8 + V7 | ✅ | No malware scanner available — explicitly marked |
| 41 | No opaque trust score | factual claims only; no score anywhere | review | ✅ | — |
| 42 | No AI in the decision path | deterministic engine only | code review | ✅ | — |
| 43 | Polished UX flow with persisted progress | client screens | spotchecks + L1 | ✅ | — |
| 44 | Badge semantics + accessibility | badge components (text labels, roles) | spotchecks | ✅ | — |
| 45 | Verification ≠ authorization; safeguarding intact | zero changes to visibleToOrg gates | V9 + m12/m13 regressions | ✅ | — |
| 46 | Grassroots path without corporate domains | grassroots evidence route → human review | V17 | ✅ | — |
| 47 | Agency verification cannot bypass adult-only representation | existing isAdult checks untouched | V9 + #14 | ✅ | — |
| 48 | Honest migration (no false upgrades) | `migrateM14` | migration checks | ✅ | — |
| 49 | Clean m14/ module w/ pure helpers | `m14/{shared,organisations,review,index}.mjs` | unit | ✅ | — |
| 50 | One canonical safe projector | `toPublicVerificationProfile()` | V1 step 8/9 + V12 | ✅ | — |
| 51 | Effective-claim engine at read time | `effectiveStatus()` | V5/V10/V11 | ✅ | — |
| 52 | Cascading authority revocation → flag, not destroy | `claimsByAuthority` + review flags | V10 | ✅ | — |
| 53 | Provenance graph traversable | claim→evidence→method→authority→org→reviewer ids | V16 + provenance checks | ✅ | — |
| 54 | 18 security audit cases | m14E2E security section | all fail safely | ✅ | — |
| 55 | V1–V18 acceptance journeys | m14E2E | all | ✅ | — |
| 56 | All existing regressions green | full re-run | post-implementation | ✅ | — |
| 57 | All five client apps updated | m14 client files | tsc + builds + spotchecks | ✅ | — |
| 58 | Demo personas (8 states) | m14demo fixtures | spotchecks | ✅ | — |
| 59 | i18n EN+FR complete | i18n catalogues | tsc (fr: typeof en) | ✅ | — |
| 60 | F12 audit integration | ledgerAppend + verEvents + audit export | m14E2E | ✅ | — |
| 61 | Metrics without PII | `metrics.verification*` counters | /admin/metrics check | ✅ | — |
| 62 | Fail closed (authz) / fail honest (providers) | 403s; `temporarily_unavailable` | V8 provider-down check | ✅ | — |
| 63 | Provider abstraction w/ configured/not_configured/unavailable/unsupported | licence + identity provider registry | V8 | ✅ | — |
| 64 | Human boundary exactly as specified | decideReview reason codes | V3/V17 | ✅ | — |
| 65 | UX copy defines the verified fact | badge labels | spotchecks | ✅ | — |
| 66 | Architecture doc + Mermaid state diagram | `M14_VERIFICATION.md` | docs | ✅ | — |
| 67 | This matrix | this file | — | ✅ | — |
| 68 | Honest limitations in final report | final report | — | ✅ | — |
| 69 | Indexed read paths, no N+1 badge lookups | in-memory claim index + batch projector | perf check in m14E2E | ✅ | — |
| 70 | No M12/M13 regressions | integration not forking | full regression run | ✅ | — |
| 71 | Quality bar checklist | final verification | all suites | ✅ | — |
| 72 | Live browser journeys L1–L7 in separate contexts | `e2e/m14Live.test.mjs` | L1–L7 | ✅ | — |
| 73 | ≥⅓ negative tests with exact status codes | m14E2E composition | counted in suite | ✅ | — |
