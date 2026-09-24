# M23 P8 — Journey block matrix

What a block (the player, or the guardian of a minor, blocking a club:
`db.blocks`, `isBlocked(playerId, orgId)`) does to each stage of the journey
(§49). The frozen rule from P3–P7: **a block stops data flowing forward; it
never erases truth.** Closure and history stay readable under the frozen
rules of each domain.

| Stage / surface | Effect of a block | Where | History |
| --- | --- | --- | --- |
| Discovery, watchlists, matching | the player is not visible to the org (`orgCanSee` composes `visibleToOrg` with `!isBlocked`) | M12/M19 | — |
| Room / case | the case stays; the player header reads withheld (`playerAvailable: false`); the journey block sets `blocked: true` and every club act's `nextAction.blockedBy = ['BLOCKED']` (the act is named, not offered) | `journey.mjs`, M17 | the timeline stays complete |
| Contact | a draft can be written; `send` is refused (`CONTACT_BLOCKED`); an external record is refused; an existing delivered Contact and its answer stay readable; the recipient's Inbox row stays | `m23/contactRoutes.mjs` | kept |
| Inbox / channels | no new message reaches the recipient | core | kept |
| Trial | the club may only `cancel` or `report` (`BLOCKED_CLUB_ACTIONS_ALLOWED`); no invitation, reschedule, attendance or completion; the recipient's own acts are unaffected | `m23/trial.mjs`, `trialRoutes.mjs` | kept |
| Assessment | club material; unaffected (an assessment is the club's own record) | M12 | kept |
| Decision | the club may still decide (a `reject` or `hold` is the honest outcome of a block); `progress` moves nothing forward the Offer gate will accept | `m23/decisionRoutes.mjs` | kept |
| Offer | drafting/issuing refused (`OFFER_BLOCKED` in `draftBlockers` / `issueBlockers`); an issued Offer stays readable by both sides; the recipient may still answer their own issued Offer | `m28/index.mjs` | kept |
| Signing | start refused; the completion gate names `BLOCKED`; a presented package stays readable; the player's own notifications about it are suppressed (`notifyPlayer` checks the block) | `m29/index.mjs` | kept |
| Notifications | none reach the recipient about the blocking org's new acts; the notification target resolver resolves an Offer or package target to nothing for a blocked player (§31: conceal) | `server.mjs notify`, `m23/journeyRoutes.mjs` | rows stay |
| Journey projection (club) | `blocked: true`; next action carries `blockedBy`; stage, completed stages, resources and timeline unchanged | `journey.mjs` | unchanged |
| Journey projection (player) | the player still sees what they were sent (their requests, trials, Offers, signings) and their own journey line — a block is their act and hides nothing from them | `journey.mjs` | unchanged |
| Analytics | counts what happened; a blocked case is neither removed nor advanced | M20 | — |
| Unblock | lifted by Trust & Safety (`/admin/blocks/:id/lift`); every gate re-derives on the next request; nothing is replayed automatically | admin | — |

Proof: `m23RecruitmentJourneyE2E` C1 (a blocked contact moves nothing and the
journey names the block), A21 (the model names `BLOCKED` on club acts and on no
wait), the P3/P4/P6/P7 block groups (unchanged and green), and the P7
M23_P7_SIGNING_BLOCK_MATRIX.md (unchanged).
