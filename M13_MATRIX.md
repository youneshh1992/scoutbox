# Milestone 13 — requirements matrix

One row per acceptance criterion. **Existing** = behaviour before M13. **Change** = what M13 adds.
**Where** = backend module · screens. **Perms** = who may act. **Evidence** = test that proves it.
Status: ⬜ pending → ✅ done / 🚧 blocked (with reason).

Baseline check (§1): working tree clean at b699ac0; M12 modules, tests and artifacts verified present.
Under-16 wording audit: server gates use DOB-based `isAdult()` (age-of-majority, default 18) everywhere;
"under-16" appeared only in launcher copy. `< 16` exists solely as the u16 *search band filter*.
Boundary tests for 16- and 17-year-olds (DOB + controlled date) added in `scripts/m13E2E.mjs`.

| # | Criterion | Existing | Change | Where | Perms | Evidence | Status |
|---|---|---|---|---|---|---|---|
| F1.1 | Validated CSV imports correctly | none | template→map→validate→dry-run→commit pipeline | m13/imports.mjs · Pro/Grassroots Imports screen | org lead | m13E2E F1 | ✅ |
| F1.2 | Reimport does not duplicate | none | provider+externalId dedupe, row skip report | imports.mjs | org lead | m13E2E F1 | ✅ |
| F1.3 | Ambiguous identities require review | none | identity review queue; no name-only merges | imports.mjs · review UI | org lead resolves | m13E2E F1 | ✅ |
| F1.4 | Unauthorised imports/exports fail | none | lead-only imports; scoped API keys for export | imports.mjs | scoped | m13E2E F1 neg | ✅ |
| F1.5 | Webhook signatures + retries verified locally | none | HMAC-signed deliveries, bounded retries, rotation, SSRF guard | imports.mjs + sweep | org lead | m13E2E F1 local receiver | ✅ |
| F1.6 | Connectors show "not configured" | none | provider registry, all inactive until credentialed | imports.mjs · UI badge | org | m13E2E F1 | ✅ |
| F2.1 | Player/guardian starts or approves transition | release-with-reference existed | consent-first transition cases | m13/transitions.mjs · Player You / guardian | player(adult)/guardian | m13E2E F2 | ✅ |
| F2.2 | Selected eligible clubs get only permitted evidence | none | per-recipient grants, selected pack only | transitions.mjs | recipient must pass visibleToOrg | m13E2E F2 | ✅ |
| F2.3 | Revocation stops future access + notifies | none | revoke → grant dead, withdrawal notices | transitions.mjs | owner | m13E2E F2 | ✅ |
| F2.4 | No false "remotely erased" claim | n/a | withdrawal copy says access stops, downloads can't be recalled | transitions.mjs responses | — | m13E2E F2 copy check | ✅ |
| F2.5 | Placement closes case, history kept | none | placed status; history append-only; level review audited, not automatic | transitions.mjs | case owner / admin level review | m13E2E F2 | ✅ |
| F3.1 | Conflicting training schedule detected | none | slot overlap check vs opportunity requirements | m13/suitability.mjs · Player You / opp board | player/guardian own prefs | m13E2E F3 | ✅ |
| F3.2 | Time zones handled correctly | none | slots stored with tz, compared in UTC | suitability.mjs | — | m13E2E F3 tz fixture | ✅ |
| F3.3 | Private info never leaks to clubs/search/exports | none | clubs see only approved summary verdicts | suitability.mjs | player-approved summaries only | m13E2E F3 neg | ✅ |
| F3.4 | Preference change updates matching | none | live recompute on read | suitability.mjs | — | m13E2E F3 | ✅ |
| F3.5 | Eligibility stays separate from preferences | M12 checkEligibility | suitability shown alongside, never overrides; travel time "unavailable" without provider | suitability.mjs | — | m13E2E F3 | ✅ |
| F4.1 | Under-reviewed eligible players enter review queue | none | not-yet-assessed queue + reminders + stale flags | m13/insight.mjs · Pro review queue | org (eligible players only) | m13E2E F4 | ✅ |
| F4.2 | Ineligible players never enter rotation | visibleToOrg | rotation draws only from currently-visible set | insight.mjs | — | m13E2E F4 neg | ✅ |
| F4.3 | Metrics: defined denominators, deduped events | none | (org,player,kind,day) dedupe; 90-day window declared | insight.mjs | org lead | m13E2E F4 | ✅ |
| F4.4 | Small aggregates suppressed | M12 n<3 pattern | birth-quarter + funnel aggregates suppress n<3 | insight.mjs | org lead / admin | m13E2E F4 | ✅ |
| F4.5 | Missing evidence ≠ poor ability | none | absent-evidence bucket separate from low ratings | insight.mjs | — | m13E2E F4 | ✅ |
| F4.6 | 16/17-year-old discovery stays guardian-safe | isAdult gates | boundary tests at 16/17/18 by DOB | domain + insight | — | m13E2E age suite | ✅ |
| F5.1 | Blind: prior responses inaccessible during submission | M12 blind assessments | calibration sessions reuse + enforce blind gate | m13/insight.mjs · Pro Calibration | participants | m13E2E F5 | ✅ |
| F5.2 | Rating-scale changes don't alter history | M12 attributesSnapshot | rubric version pinned per session | insight.mjs | — | m13E2E F5 | ✅ |
| F5.3 | "Not observed" excluded | M12 | same rule in disagreement math | insight.mjs | — | m13E2E F5 | ✅ |
| F5.4 | Disagreement math verified with known examples | none | range/spread per attribute, fixture-tested | insight.mjs | — | m13E2E F5 fixtures | ✅ |
| F5.5 | Restricted footage stays restricted | M11 signed media | session footage via existing entitlement checks | insight.mjs | participants only | m13E2E F5 neg | ✅ |
| F6.1 | Known gaps → deterministic recommendations | none | versioned rule engine (rule id+version+records+explanation) | m13/insight.mjs · Pro/Grassroots player view | org | m13E2E F6 | ✅ |
| F6.2 | New evidence resolves the right gap | none | suggestion recompute; supplied/reviewed statuses | insight.mjs | org | m13E2E F6 | ✅ |
| F6.3 | Irrelevant evidence does not resolve | none | rule matches on kind/attribute | insight.mjs | — | m13E2E F6 | ✅ |
| F6.4 | Requests to minors go via guardians | M12 guardian routing | evidence requests reuse notify guardian routing | insight.mjs | — | m13E2E F6 | ✅ |
| F6.5 | No inaccessible source leaked | club-private notes exist | player-visible explanations built only from player-visible records | insight.mjs | — | m13E2E F6 neg | ✅ |
| F7.1 | Lead assigns scout to uncovered fixture | none | fixtures, coverage plans, assignments | m13/planning.mjs · Pro Coverage | lead assigns | m13E2E F7 | ✅ |
| F7.2 | Duplicate visits flagged | none | same-fixture assignment warning | planning.mjs | — | m13E2E F7 | ✅ |
| F7.3 | Completed observation updates coverage | M12 assessments | observation links assignment→assessment | planning.mjs | scout | m13E2E F7 | ✅ |
| F7.4 | Suggestions only permitted players/events | visibleToOrg | candidate lists filtered live | planning.mjs | — | m13E2E F7 neg | ✅ |
| F7.5 | Route estimates honest | none | user-entered budget; "travel time unavailable" without provider | planning.mjs | — | m13E2E F7 | ✅ |
| F8.1 | Two clubs isolated until specific grant | org isolation | groups + explicit grants, default isolated | m13/groups.mjs · Pro Group screen | group admin + resource owner | m13E2E F8 | ✅ |
| F8.2 | Grant removal hits API/media/events immediately | M11 revocation pattern | grant checked live on every read | groups.mjs | — | m13E2E F8 | ✅ |
| F8.3 | Group admin cannot bypass U18/Grassroots rules | visibleToOrg | permission = intersection incl. player eligibility | groups.mjs | — | m13E2E F8 neg | ✅ |
| F8.4 | Aggregates suppress small groups | M12 pattern | group reports n<3 suppression | groups.mjs | group admin | m13E2E F8 | ✅ |
| F8.5 | Leaving preserves ownership, removes access | none | departure keeps records with owner org | groups.mjs | — | m13E2E F8 | ✅ |
| F9.1 | Money fixtures: totals, periods, rounding, currency | none | integer minor units; per-currency totals | m13/planning.mjs · Pro case Budget tab | finance-visible roles | m13E2E F9 fixtures | ✅ |
| F9.2 | Editing one scenario doesn't change another | none | scenarios are independent versions | planning.mjs | case access | m13E2E F9 | ✅ |
| F9.3 | Unknown contingent amounts stay unknown | none | conditional lines excluded from totals, listed separately | planning.mjs | — | m13E2E F9 | ✅ |
| F9.4 | Only authorised financial roles see amounts | lead concept | finance-role gate on amounts | planning.mjs | lead/finance | m13E2E F9 neg | ✅ |
| F9.5 | Approval attributable + version-specific | none | approval {by, at, scenarioVersion} | planning.mjs | lead | m13E2E F9 | ✅ |
| F10.1 | Adult confirms proposed relationship | none | representation lifecycle | m13/transitions.mjs · Player You (adult), Pro agency lane | adult player confirms | m13E2E F10 | ✅ |
| F10.2 | States labelled accurately | none | proposed/active/withdrawn/expired/disputed; credential = "uploaded, unverified" until review | transitions.mjs | — | m13E2E F10 | ✅ |
| F10.3 | Withdrawal revokes access | none | live status check on agency reads | transitions.mjs | player | m13E2E F10 | ✅ |
| F10.4 | Historical attribution retained | none | history append-only | transitions.mjs | — | m13E2E F10 | ✅ |
| F10.5 | Under-18 denied everywhere | agency wall | DOB-evaluated 403 on all representation routes | transitions.mjs | — | m13E2E F10 neg 16/17 | ✅ |
| F10.6 | Age from DOB, not stale flag | isAdult | representation checks isAdult() live | transitions.mjs | — | m13E2E age suite | ✅ |
| F11.1 | Retry doesn't duplicate business action | notify() in-app only | outbox dispatcher; dispatch separate from notification | m13/delivery.mjs | system | m13E2E F11 | ✅ |
| F11.2 | Duplicate callbacks don't corrupt status | none | idempotent signed callbacks, out-of-order safe | delivery.mjs | provider HMAC | m13E2E F11 | ✅ |
| F11.3 | Cancellation requiring ack is visible | none | actionRequired + deadline + ack endpoint | delivery.mjs · all apps | recipient | m13E2E F11 | ✅ |
| F11.4 | Email acceptance not reported as read | none | status ladder caps at "accepted" without confirmation | delivery.mjs | — | m13E2E F11 | ✅ |
| F11.5 | Guardian routing + suppressed previews correct | M12 contentless child notices | delivery respects audience routing | delivery.mjs | — | m13E2E F11 | ✅ |
| F11.6 | Restart preserves queued work | M12 sweep pattern | dispatches persisted; sweep resumes | delivery.mjs | — | m13E2E F11 SIGKILL | ✅ |
| F12.1 | Invited staff complete onboarding | ad-hoc login | invites + guided setup tasks | m13/enterprise.mjs · Pro/Grassroots onboarding | lead invites | m13E2E F12 | ✅ |
| F12.2 | MFA + recovery work | none | TOTP (RFC 6238, fixture-tested) + hashed one-time recovery codes, rate-limited | enterprise.mjs | privileged users | m13E2E F12 | ✅ |
| F12.3 | Local SSO: success, bad state/nonce, unauthorised linking | none | OIDC code flow vs in-process test IdP; no group-claim bypass | enterprise.mjs | org-configured | m13E2E F12 SSO | ✅ |
| F12.4 | Audit exports respect tenant boundaries | ledger exists | scoped audit export per org | enterprise.mjs | lead/admin | m13E2E F12 neg | ✅ |
| F12.5 | Restored backup supports representative workflows | none | backup manifest+checksums; restore to empty dir; smoke test | enterprise.mjs + scripts/backupRestore | admin | backupRestore test | ✅ |
| F12.6 | Monitoring detects injected failures | none | metrics + health/ready + status view; failure-injection test | enterprise.mjs | admin | m13E2E F12 | ✅ |
| F12.7 | Load results honestly stated | none | bounded local load script reporting dataset/concurrency/duration/errors | scripts/m13Load.mjs | — | load report in docs | ✅ |

## Deliberately NOT implemented (would be fabrication)
- Travel-time estimates (no routing provider) — distance + "travel time unavailable" shown instead.
- Independent licence verification for representation credentials — recorded as "uploaded, review pending".
- Real email/SMS/push delivery — local fake provider only; external channels marked "not configured".
- Corporate SSO against a real IdP — local test IdP only; screens say "no identity provider configured".
- Market values / resale projections / sell-on fee activation (F9) — user-entered figures only.
- Ethnicity/socioeconomic/maturity inference (F4) — birth-quarter aggregates only, suppressed under n<3.
