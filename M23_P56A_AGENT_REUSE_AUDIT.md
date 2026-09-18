# M23 P5.6A — Agent Reuse Audit

What the future ScoutBox Agent product (P5.6B–E) reuses from the existing
tree, what it extends, what it must build new, and what it must **not**
reuse. Classes are the mandate's four (§174): **REUSE** (as is, through the
existing seam), **EXTEND** (existing seam plus additive change), **NEW**
(nothing suitable exists), **DO NOT REUSE** (something exists and looks
suitable but must not carry the Agent product).

The server is one synchronous composition (`scoutbox-server/server.mjs`
builds the core, then `register*(ctx)` per module; `app.listen` is last), so
every module-registered store and seam exists before any request
(`storeContract.mjs:1-60`). Everything below assumes the Agent modules
register the same way (`registerM24(ctx)` or whatever P5.6B names it) and
receive the same `ctx`.

Line references are to `669d060`.

---

## 1. Users / auth / sessions — REUSE

| Item | Where | Reuse verdict |
|---|---|---|
| `createSession(kind, refId, extra)`, `sessionFor(req)`, Bearer-only resolution, `POST /auth/logout` | `server.mjs:555-578` | **REUSE.** Sessions stay `kind: 'org'` for agency users; an agent is an org user whose org is an agency. No new session kind: the licensed individual is identified by `userId`, not by a session flavour. |
| `orgAuth` (rejects removed user, suspended org) → `req.org`, `req.orgUser` | `server.mjs:1639-1653` | **REUSE** as the first two steps of the authorization order (authenticate → resolve individual). |
| `revokeOrgUserAccess(userId)` kills sessions and SSE | `server.mjs:3990` | **REUSE** for agent removal from an agency (affiliation ended) and for licence revocation. |
| MFA (`user.mfa`, `mfaRequiredForLeads`) | `server.mjs:1597-1618, 1631` | **EXTEND**: agencies get `mfaRequiredForLicensedAgents` (same nudge-not-lockout shape) because a regulated action must be attributable to one person (P-2). |
| `/auth` limiter | `server.mjs:581-582` | **REUSE.** |
| `POST /auth/org/login` writes `user.role` from the body on every login | `server.mjs:1621-1624` | **DO NOT REUSE for authority.** The role string stays cosmetic. Agent authority derives from `agencyAffiliations.tier` + verified licence, never from `req.body.role`. |
| Dev logins | `server.mjs:585-593` | **REUSE** (gated as today). |

## 2. Organisations — EXTEND

| Item | Where | Verdict |
|---|---|---|
| `db.orgs` with `type: 'agency'` | `seed.mjs:15-88`, `server.mjs:1523-1552` | **EXTEND.** The agency org is the tenant. Add (P5.6B, migration): `platform: 'agent'` for agency orgs, validation of `type`, `agencyRegulatoryProfile` (jurisdictions the agency operates in; nothing that pretends to be a licence). |
| Self-serve grassroots registration | `server.mjs:1526` | **DO NOT REUSE** as is. Agencies are provisioned by T&S today (`server.mjs:3887`); an agency self-registration flow, if built, is P5.6B B1 and must not mint anything regulated (it creates an unverified tenant). |
| `orgSafe()` | `server.mjs:530` | **REUSE.** |
| Org suspension / revocation cascade into claims (`effectiveStatus`) | `m14/shared.mjs:115-144` | **REUSE**: a suspended agency does not suspend its agents' *licences* (those are personal) but does suspend every agency-tenanted action. |

## 3. Roles — NEW (modelled on M14 verAdmins)

| Item | Where | Verdict |
|---|---|---|
| `isLead` regex, `requireLead` | `m13/shared.mjs:211-216` | **DO NOT REUSE** for anything regulated. A regex over a self-typed string cannot gate a Football Agent Service. It may still gate agency *administrative* views (audit page) in P5.6B for parity, but the store proposal replaces it inside the Agent app. |
| `db.verAdmins` + `VER_LEVELS`, self-promotion block, dual control, last-root protection | `m14/organisations.mjs:569-651` | **REUSE the pattern, not the store.** `agencyAffiliations.tier ∈ licensed_agent \| agency_admin \| analyst \| assistant \| finance` with the same invariants: no self-promotion, dual control for `agency_admin` transfer, last-admin protection. |
| Room roles `roomRole` / `roomCan` | `m17/shared.mjs:581-640` | **DO NOT REUSE.** Room roles are club recruitment roles. Transaction Room roles are a new table (`M23_P56A_AGENT_FINAL_ARCHITECTURE.md` §8). |

## 4. Player profile — REUSE (read side), DO NOT REUSE (`agentName`)

| Item | Where | Verdict |
|---|---|---|
| `playerViewForOrg` and the visibility gate | `server.mjs:911-955`, `domain.mjs:65-82` | **REUSE** verbatim for adult prospects and clients. |
| Player `agentName` | player shape | **DO NOT REUSE.** Self-reported free text; replaced by the confirmed-agreement counterparty in P5.6E. |
| `isAdult` | `domain.mjs:5-40` | **REUSE**, plus **NEW** `isRegulatoryMinor` (under 18 regardless of country). |

## 5. Guardian system — REUSE

| Item | Where | Verdict |
|---|---|---|
| Guardian signup → e-mail → ID → disclaimer ladder; `guardianAuth`; `childIds` | `server.mjs:1075-1149, 1155, 1177` | **REUSE.** Guardian approach consent and guardian agreement consent are new *consent kinds* recorded against an existing verified guardian; no new guardian identity. |
| `resolveContactRecipient` (fails closed on ambiguous guardianship, unverified guardian) | `m23/contact.mjs:241-272` | **EXTEND.** The minors pathway needs the same resolver *without* the `visibleToOrg` short-circuit at `:248`, i.e. a `resolveGuardianForRegulatedApproach` that takes the narrower minors predicate. New function, same rules, same refusals. |
| Guardian inbox / respond | `server.mjs:1259-1334` | **EXTEND** with the two guardian consent kinds (approach consent; agreement consent). |
| `guardianManagedOnly` injection for minors | `server.mjs:4232` | **REUSE.** |

## 6. Blocks — REUSE

| Item | Where | Verdict |
|---|---|---|
| `db.blocks`, `isBlocked`, `POST /player/block`, `POST /guardian/block`, T&S lift | `server.mjs:548-550, 1455-1463, 3485-3490, 3931` | **REUSE.** An agency is blockable exactly like a club; a block ends every current agent access to that player (including an active agreement's private access) and refuses new agreements. Direction stays player/guardian → org; a per-agent block is **NEW** only if counsel/product want it (DR-27, deferred). |
| Urgent report → system block | `server.mjs:1498-1501` | **REUSE.** |

## 7. Contact / Inbox — EXTEND (not REUSE)

| Item | Where | Verdict |
|---|---|---|
| `issueRecruitmentRequest` (single writer), `requestForRecipient`, routing rule Scout → Parent | `server.mjs:1849-1895, 1971-1988` | **EXTEND.** The player/guardian Inbox is reused as the *delivery surface* for agent proposals (a `representation_proposal` request type routed like any other), so players keep one inbox. The proposal object itself is new (`representationAgreements` in `proposed`). |
| M23 Contact model (`recruitmentContacts`, channels, cooldowns) | `m23/contact.mjs`, `m23/contactRoutes.mjs` | **DO NOT REUSE for regulated Approaches.** A club Contact is a club→player recruitment record; an agent's Approach is a regulated act with different preconditions (licence, timing, guardian consent) and different retention. Reuse only the *infrastructure*: `normaliseClientKey`, `payloadFingerprint`, `cooldownFor` pattern, `sendDomainError`. |
| Answer to §191 "Existing Inbox can be reused" | | **YES** — as the delivery surface, with a new request type; not as the record of the agreement. |

## 8. Notifications — REUSE + EXTEND

| Item | Where | Verdict |
|---|---|---|
| `notify(audience, type, text, refId)`, coalescing, quiet hours, minors' school-hours mute | `server.mjs:605-684` | **REUSE.** Audiences `player \| guardian \| org_user` suffice (an agent is an `org_user`). |
| `TYPE_CATEGORY`, `CATEGORIES` | `m182/notificationPrefs.mjs:28-120` | **EXTEND** with the agent types (`agent_verified`, `representation_proposed`, `representation_confirmed`, `representation_terminated`, `guardian_consent_requested`, `dual_representation_consent_requested`, `conflict_review_required`, `transaction_updated`) in a `representation` category and a `compliance` category (mandatory, like `security_account`). |
| Delivery centre / outbox | `m13/delivery.mjs` | **REUSE.** |
| Answer to §191 "Existing notifications can be reused" | | **YES** (with new types registered). |

## 9. Audit — REUSE + EXTEND

| Item | Where | Verdict |
|---|---|---|
| Per-record append-only history (`audit()` / `histAppend`; M23 `{id, at, action, by:{kind,userId,name}, detail}`) | `m12/shared.mjs:67-70`, `m13/shared.mjs:206` | **REUSE** the M23 shape on every new record. |
| `GET /org/audit` projection, `safeDetail` allowlist, subject named only if `orgCanSee` at read time | `m182/audit.mjs:71-86, 212-229` | **EXTEND**: add `AGENT_ACTIONS` / `AGREEMENT_ACTIONS` / `TRANSACTION_ACTIONS` sets and a loop in `entriesFor()`. The allowlist must never carry fee terms, note bodies or conflict-reason prose (codes only). |
| `db.verEvents` with declared-reviewer attribution | `m14/index.mjs:70-91`, `m14/review.mjs:60-72` | **REUSE** for licence/accreditation review events. |
| Answer to §191 "Existing audit infrastructure can be reused" | | **YES.** |

## 10. Event registry / SSE — EXTEND

| Item | Where | Verdict |
|---|---|---|
| `EVENT_REGISTRY`, `minimizePayload`, `assertEventRegistry`, `EMITTED_EVENTS` | `m182/eventRegistry.mjs:51-422`, `server.mjs:4285` | **EXTEND** with the seven §135 events, audience `org_private` + `payload.orgId` (the agency), `player_private` twins for the client. No `agency_private` audience needed. `trust_safety_only` remains effectively unreachable (`sseIdentityFor` never yields `admin`) — pre-existing, recorded, not an Agent concern. |

## 11. Files / documents — EXTEND (M14 evidence vault), DO NOT REUSE (player media)

| Item | Where | Verdict |
|---|---|---|
| `db.verEvidence`, `EVIDENCE_MIME_ALLOW`, magic-byte sniff, 8 MB, visibility levels `trust_and_safety \| organisation_internal \| subject_only` | `m14/shared.mjs:236-272` | **EXTEND.** Agreement scans, guardian consent scans, licence documents and DBS/authorisation letters are M14 evidence records with a new `subject` kind (`agreement`, `consent`, `agent`). Same allowlist, same sniff, same "not malware scanning" honesty. Visibility for an agreement document: `subject_only` extended to "parties to the agreement" (a **NEW** `parties_only` level, P5.6B). |
| Player media uploads + signed URLs | `m12/operations.mjs:150-246`, `server.mjs:299-338, 3951-3983` | **DO NOT REUSE** for regulatory documents (video/image MIME set, 15-minute session-bound URLs designed for footage). Signed-URL gate pattern is reused for evidence download. |
| Answer to §191 "Existing file storage can be reused" | | **YES** (M14 evidence vault), with a new visibility level. |

## 12. Verification — EXTEND

| Item | Where | Verdict |
|---|---|---|
| Claims, `applyTransition`, `effectiveStatus`, `AUTHORITATIVE_METHODS`, `decideReview`, `NO_AUTHORITATIVE_SOURCE` | `m14/shared.mjs:19-235`, `m14/review.mjs:79-140` | **EXTEND.** Licence claims are the agent verification spine. New: subtype metadata, `recheckAt`, and the fail-honest state vocabulary (`verified`, `verification_pending`, `verification_stale`, `manual_review_required`, `unverifiable`) mapped onto the 12 claim states rather than replacing them. **No register integration exists**; a licence is `verified` only after a T&S human review of the FIFA directory / FA list *and* it becomes `verification_stale` at `recheckAt` (default 30 days, DR-6). |
| Tokens (`mintToken`, `peekToken`) | `m14/shared.mjs:298+`, `m14/organisations.mjs:730-740` | **REUSE** for client-confirmation links sent outside the app (optional). |
| `db.verAdmins` pattern | see §3 | pattern reused. |

## 13. Trust Score — DO NOT REUSE (as an input), REUSE (as a read)

| Item | Where | Verdict |
|---|---|---|
| Read routes; no write route anywhere | `m162/trust.mjs:183-254` | **REUSE** reads through `safeTrustProjection` with a new `agent_client` viewer case (P5.6B, DR-21). **DO NOT** create a write route; agents never edit the score (§191). |
| Relationship source counts confirmed representations | `m162/trust.mjs:84-87` | Defect D-P56A-1 fixed; P5.6B re-points it at `representationAgreements` in `active` state with a licensed agent, keyed by `agentUserId`. |

## 14. Passport — REUSE

| Item | Where | Verdict |
|---|---|---|
| `projectPassport` with viewer `agency` | `m15/shared.mjs:626-760` | **REUSE.** Client view = `recruitment` visibility; anything wider only via the player's own M15 share. Agents never own or edit the Passport (§191). |

## 15. Trial — DO NOT REUSE (as an agent object); REUSE (read-through for clients)

| Item | Where | Verdict |
|---|---|---|
| Trial engine, family view, `issueAcceptedTrial` | `m23/trial.mjs`, `m23/trialRoutes.mjs`, `server.mjs:1904-1969` | **DO NOT REUSE** as anything an agent creates. Trials are club↔player/guardian objects. A client may *share* a trial's family view with their agent (`P5.6E`, new `player-shared` projection through `GET /player/recruitment/shared`'s pattern); the agent never sees `trialDetails.private` beyond what the client shares. |

## 16. Assessment — DO NOT REUSE

| Item | Where | Verdict |
|---|---|---|
| Blind rule, single feedback door, published feedback | `m12/scouting.mjs:86-95, 306-343` | **DO NOT REUSE / NEVER EXPOSE.** Private club assessments never reach an agent (§191). Only *published feedback* the player already holds may be shared onward by the player. |

## 17. Recruitment Room / Case — DO NOT REUSE as the transaction object

| Item | Where | Verdict |
|---|---|---|
| `db.recruitmentCases`, `applyLifecycleTransition`, `captureRoomSnapshot` | `m17/rooms.mjs:538-558`, `server.mjs:4215` | **DO NOT REUSE.** A Case is one club's private view of one player; a Transaction has multiple parties, a jurisdiction, a conflict evaluation and a consent ledger, and the club's Case content (assessments, decisions, notes) must never be visible across it. Answer to §191 "Existing Recruitment Case can serve as regulated transaction object": **NO.** A Transaction may *link* a Case id one-way (club side only) in P5.6E. |
| M23 formal decisions | `m23/decisionRoutes.mjs` | **NEVER EXPOSE** (§191). |

## 18. Offer (future) — NEW, not designed here

Offer Workflow is out of scope (§195). The Transaction Room reserves a
`terms` tab and a `transactionTerms` record shape; no Offer object is
proposed here.

## 19. Rate limiter — EXTEND

| Item | Where | Verdict |
|---|---|---|
| `RATE_LIMIT_POLICY`, `limited()`, memory-only provider that refuses to pretend | `m181/rateLimit.mjs:30-199` | **EXTEND** with actions: `agent_representation_propose` (scope `actor`, tight — anti-spam §143), `agent_guardian_consent_request` (scope `actor`, tighter), `agent_conflict_evaluate` (scope `org`), `agent_licence_submit` (scope `actor`), `agent_directory_read` (scope `ip`). Product cooldowns (one proposal per agent+player per 30 days) are deterministic rules, not limiter entries, following `cooldownFor()` (`m23/contact.mjs:310`). |

## 20. Idempotency — REUSE

`normaliseClientKey`, `payloadFingerprint`, `record.keys.<action> = {key, fp}`
/ capped arrays, `*_IDEMPOTENCY_CONFLICT` (`m23/contact.mjs:216-222,
322-324`, `m23/trialRoutes.mjs:91-101`). **REUSE** verbatim on every agent
mutation.

## 21. Rev / conflicts — REUSE

`m181/concurrency.mjs` (`expectedRevOf`, `guardRev`, `bumpRev`, `revMeta`).
**REUSE** on agreements, transactions, consents (a consent is append-only,
so `rev` guards the *ledger record* it attaches to).

## 22. Tombstones / deletion — EXTEND

| Item | Where | Verdict |
|---|---|---|
| `deletePlayerData`, `tombstoneRequest`, `tombstoneTrial`, `subjectRemovedAt` | `server.mjs:3633-3746` | **EXTEND** with `tombstoneAgreement` and `tombstoneTransactionParty`: person-shaped fields nulled, ids/states/times/policy version kept, because regulators require agreement records to persist (R-F25 14-day duty, FA lodging) and counsel must settle erasure vs retention (L-11). Until L-11 is answered, the tombstone keeps `{ id, agentUserId, agencyOrgId, jurisdiction, startAt, endAt, terminatedAt, policyVersion, statusHistory }` and nothing else. |
| Org-user removal keeps the row with `removedAt` | `server.mjs:3990` | **REUSE**: an agent who leaves an agency keeps attributed history; their agreements do not transfer (R-F10; assignment is L-10). |

## 23. Trust & Safety — EXTEND

| Item | Where | Verdict |
|---|---|---|
| Shared `x-admin-key`, declared-reviewer headers, `attribution: 'shared_admin_key'` | `server.mjs:3815-3820`, `m14/review.mjs:60-72` | **REUSE with the known limitation stated.** Licence review, minors-authorisation review, dispute handling and `MANUAL_REGULATORY_REVIEW_REQUIRED` queues sit behind it. Per-reviewer identity is a pre-existing gap (documented in M14.1); it becomes **High** the day a T&S decision *authorises* a regulated action, so P5.6C (the engine) must not ship a T&S "approve conflict" action without per-reviewer attribution (DR-29). |
| Moderation (`moderateOrRefuse`, grooming → urgent report) | `server.mjs:884-906` | **REUSE** on every free-text field an agent can write toward a player or guardian. |
| Reports (`handleReport`, `targetKind ∈ club\|scout\|player`) | `server.mjs:1467-1506` | **EXTEND** `targetKind` with `agent` (an individual) so a player can report the person, not just the agency. |

## 24. Analytics (M20) — DO NOT REUSE (as a data source)

The M20 reporting context is club-scoped. Agent analytics, if any, are a
separate context in P5.6D and must never read assessments, decisions or
club Cases. No agent ranking, no paid ranking (§191).

## 25. Client plumbing — REUSE

`nav.ts` config pattern + `navConfig` test loop (`e2e/navConfig.test.mjs:76`),
flat `en`/`fr` i18n objects, `api.ts` typed client, `conflict.tsx`,
`dirtyGuard.ts`, `confirmAction.ts`, demo mode. **REUSE** by copying the
pattern into `scoutbox-agent` (P5.6B; not created in P5.6A).

---

## 26. Summary

| Class | Areas |
|---|---|
| REUSE | auth/sessions, blocks, guardian identity ladder, notifications core, audit history shape, idempotency, rev, Passport projection, moderation, signed-URL gate pattern, client plumbing |
| EXTEND | orgs (platform), verification claims, evidence vault, event registry, notification types, audit sets, rate policies, tombstones, T&S queues, contact/inbox (as delivery), reports |
| NEW | agent identity (`agentProfiles`), agency membership tiers (`agencyAffiliations`), representation agreements, transactions, transaction representations, regulatory consents, jurisdiction policy layer, Conflict Engine, minors gate, `isRegulatoryMinor`, `parties_only` evidence visibility, Transaction Room roles |
| DO NOT REUSE | `role` string / `isLead` for authority, `player.agentName`, `db.representations` as the agreement, Recruitment Case as the transaction, Room roles, M23 Contact as the Approach, assessments/decisions (never), player media pipeline for documents, M20 context |

§191 answers derived here: new stores **YES** (six: `agentProfiles`,
`agencyAffiliations`, `representationAgreements`, `agentTransactions`,
`transactionRepresentations`, `regulatoryConsents`; plus a seventh
non-PII policy store `jurisdictionPolicies`, see the store proposal); Inbox
**YES**; guardian **YES**; blocks **YES**; notifications **YES**; audit
**YES**; file storage **YES**; Recruitment Case as transaction **NO**.
