/**
 * M21 — who may do what to a Development Plan. One function, one table (§73).
 *
 * Every route in this module asks `planAccess()` and nothing else. That is a
 * deliberate constraint: the alternative — each route checking ownership,
 * visibility, minority and organisation access in its own way — is how a
 * fourteenth route eventually forgets one of them.
 *
 * Four viewer contexts exist and no more (§102):
 *
 *     player_self       the player, on their own plan
 *     guardian          the guardian of a minor they own
 *     org_staff         a member of a club, on a player that club may see
 *     grassroots_staff  the same, in a grassroots organisation
 *
 * There is deliberately NO Trust & Safety context and NO agency context.
 *
 *   • T&S (§103): development plans are not a moderation surface, and the
 *     M18.2 scoped-support boundary is not widened here. If a plan ever needs
 *     to be inspected for a safeguarding reason, that is a new, scoped,
 *     audited mechanism — not a flag on this function.
 *   • Agencies (§75): an agency gains nothing through the Development Hub, and
 *     in particular gains no route to a minor. The safest reading of "must
 *     follow current restrictions" is no access at all, so that is what this is.
 *
 * The other absolute: authorisation is evaluated before lookup, and a viewer
 * with no access gets the answer a nonexistent record would give. A 403 on a
 * foreign plan id confirms the plan exists, which is itself a leak (§79).
 */

export const VIEWER_KINDS = Object.freeze(['player_self', 'guardian', 'org_staff', 'grassroots_staff']);

/** Every capability the Hub gates on. A route names one; it never re-derives it. */
export const CAPABILITIES = Object.freeze([
  'read',          // may see the plan at all
  'readInternal',  // may see organisation-internal review notes
  'writeGoals',    // may create and edit goals and actions
  'manage',        // may pause, complete, archive, change visibility and sharing
  'review',        // may submit a coach review
  'reflect',       // may submit a player or guardian reflection
  'linkEvidence',  // may attach an evidence reference
]);

const NONE = Object.freeze({
  read: false, readInternal: false, writeGoals: false,
  manage: false, review: false, reflect: false, linkEvidence: false,
});

const caps = (o) => Object.freeze({ ...NONE, ...o });

/**
 * Build the viewer context from whatever authenticated the request. Kept here
 * so a route cannot invent a viewer shape the access table has never seen.
 */
export function viewerFor({ player = null, guardian = null, org = null, orgUser = null, grassroots = false } = {}) {
  if (player) return { kind: 'player_self', playerId: player.id, isMinor: !!player.isMinor };
  if (guardian) return { kind: 'guardian', guardianId: guardian.id, childIds: guardian.childIds ?? [] };
  if (org) return { kind: grassroots ? 'grassroots_staff' : 'org_staff', org, orgUser, isLead: !!orgUser?.lead };
  return { kind: 'none' };
}

/**
 * The access table.
 *
 * `player` is the plan's subject, needed for the minority rule; `orgCanSee` is
 * the live organisation gate every other surface uses, passed in rather than
 * imported so this file stays a pure function of its arguments.
 */
export function planAccess(viewer, plan, { player, orgCanSee, isLead = () => false } = {}) {
  if (!viewer || !plan || !player) return NONE;
  if (plan.playerId !== player.id) return NONE;

  switch (viewer.kind) {
    case 'player_self': return playerAccess(viewer, plan, player);
    case 'guardian': return guardianAccess(viewer, plan, player);
    case 'org_staff':
    case 'grassroots_staff': return orgAccess(viewer, plan, player, { orgCanSee, isLead });
    default: return NONE;
  }
}

/**
 * The player, on their own plan.
 *
 * A minor gets READ on their own plan and nothing else. That is not a slight:
 * it is the existing safeguarding model, in which a minor's outward-facing and
 * record-changing actions run through the guardian. M21 introduces no new
 * direct minor capability (§74), and specifically does not become the one
 * place a minor can create records a club will read.
 */
function playerAccess(viewer, plan, player) {
  if (viewer.playerId !== plan.playerId) return NONE;
  const minor = !!player.isMinor;

  if (plan.owner.kind === 'player') {
    if (minor) return caps({ read: true });
    return caps({
      read: true, writeGoals: true, manage: true, reflect: true, linkEvidence: true,
    });
  }

  // A club's plan. The player sees it only when the club made it visible, and
  // even then never its internal notes. They may reflect on it — a player's own
  // words about their own development are always theirs to add — but they may
  // not edit the club's goals.
  if (plan.visibility !== 'player_guardian') return NONE;
  return caps({ read: true, reflect: !minor });
}

/**
 * The guardian of a minor. Authoritative for their child's own plan; a reader,
 * with a reflection of their own, on a club plan the club chose to share.
 *
 * A guardian relationship that no longer exists — the child aged up, or the
 * link was removed — yields nothing, because `childIds` is read live.
 */
function guardianAccess(viewer, plan, player) {
  if (!viewer.childIds?.includes(plan.playerId)) return NONE;
  // Once a player is an adult the guardian relationship confers no access,
  // whatever the stored child list still says.
  if (!player.isMinor) return NONE;

  if (plan.owner.kind === 'player') {
    return caps({ read: true, writeGoals: true, manage: true, reflect: true, linkEvidence: true });
  }
  if (plan.visibility !== 'player_guardian') return NONE;
  return caps({ read: true, reflect: true });
}

/**
 * Organisation staff.
 *
 * Two gates in series, and both are live. `orgCanSee` is the same wall search,
 * profiles and Rooms use, so a block or a visibility change removes access at
 * the same instant everywhere (§77). The plan's own ownership and visibility
 * then decide what that access is worth.
 *
 * `manage` is a lead capability. Archiving a plan or changing who can read it
 * is the same class of decision as archiving a Room, and follows the same rule.
 */
function orgAccess(viewer, plan, player, { orgCanSee, isLead }) {
  const org = viewer.org;
  if (!org) return NONE;
  if (!orgCanSee(org, player)) return NONE;
  const lead = viewer.isLead ?? isLead(viewer.orgUser);

  if (plan.owner.kind === 'org') {
    // Tenant isolation: another organisation's plan does not exist here (§79).
    if (plan.owner.orgId !== org.id) return NONE;
    return caps({
      read: true, readInternal: true, writeGoals: true,
      manage: lead, review: true, linkEvidence: true,
    });
  }

  // A player's own plan, shared with named organisations. Read-only, always:
  // a club never edits a plan it does not own, and never sees an internal note
  // because a player's plan has none to see.
  if (plan.visibility !== 'shared_with_org') return NONE;
  if (!(plan.sharedWithOrgIds ?? []).includes(org.id)) return NONE;
  return caps({ read: true });
}

/**
 * Can this viewer be recorded as the assignee of an action (§21)?
 *
 * The rule is ownership, not politeness: club staff can only be assigned work
 * inside their own organisation's plan, and only if they are still staff. A
 * removed colleague is not an assignee, and a colleague in another club never
 * was one.
 */
export function canAssign({ assignee, plan, player, db }) {
  if (!assignee) return { value: null };
  const kind = String(assignee.kind ?? '');

  if (kind === 'player') {
    if (assignee.id !== plan.playerId) return { error: 'ASSIGNEE_INVALID', detail: 'Only this plan’s player can be assigned as the player.' };
    return { value: { kind: 'player', id: player.id, name: player.name } };
  }

  if (kind === 'guardian') {
    const g = (db.guardians ?? []).find((x) => x.id === assignee.id && (x.childIds ?? []).includes(plan.playerId));
    if (!g) return { error: 'ASSIGNEE_INVALID', detail: 'That guardian does not manage this player.' };
    if (!player.isMinor) return { error: 'ASSIGNEE_INVALID', detail: 'This player is an adult; a guardian cannot be assigned their actions.' };
    return { value: { kind: 'guardian', id: g.id, name: g.name ?? null } };
  }

  if (kind === 'org_user') {
    if (plan.owner.kind !== 'org') return { error: 'ASSIGNEE_INVALID', detail: 'Club staff can only be assigned actions on a club-owned plan.' };
    const u = (db.users ?? []).find((x) => x.id === assignee.id && x.orgId === plan.owner.orgId && !x.removedAt);
    if (!u) return { error: 'ASSIGNEE_INVALID', detail: 'That person is not current staff of the organisation that owns this plan.' };
    return { value: { kind: 'org_user', id: u.id, name: u.name } };
  }

  return { error: 'ASSIGNEE_INVALID', detail: `Unknown assignee kind "${kind}".` };
}

/**
 * What a viewer is allowed to see OF a review (§39/§41).
 *
 * The internal note is the single most sensitive field M21 stores: it is a
 * club talking to itself about a player who can, in the shared case, read the
 * same record. It is stripped here, by capability, once — never filtered in a
 * client and never "hidden" by omission from a UI while still on the wire.
 */
export function reviewView(review, access) {
  const base = {
    id: review.id,
    planId: review.planId,
    reviewerKind: review.reviewerKind,
    reviewedByName: review.reviewedBy?.name ?? null,
    orgId: review.orgId ?? null,
    reviewedAt: review.reviewedAt,
    nextReviewAt: review.nextReviewAt ?? null,
    goalSnapshots: review.goalSnapshots ?? [],
    supersedes: review.supersedes ?? null,
    supersededBy: review.supersededBy ?? null,
    hasInternalNote: !!review.internalNote,
  };
  if (access.readInternal) {
    return { ...base, summary: review.sharedSummary ?? null, internalNote: review.internalNote ?? null };
  }
  // A player sees the shared summary only where it was explicitly shared.
  const shared = review.sharedWithPlayerAt ? (review.sharedSummary ?? null) : null;
  return {
    ...base,
    summary: shared,
    internalNote: null,
    // Honest about the existence of a private note without revealing a word of
    // it. Pretending a club record does not exist is its own kind of dishonesty.
    internalNoteNote: review.internalNote
      ? 'This review also contains notes kept inside the club. They are not shared.'
      : null,
  };
}
