/**
 * Development Plan access. Every route asks `planAccess()`.
 *
 * There is no Trust & Safety or agency viewer: plans are not a moderation
 * surface, and agencies get no route to a minor through the Hub. A viewer
 * with no access gets the answer a nonexistent record would give.
 */

export const VIEWER_KINDS = Object.freeze(['player_self', 'guardian', 'org_staff', 'grassroots_staff']);

export const CAPABILITIES = Object.freeze([
  'read', // may see the plan at all
  'readInternal', // may see organisation-internal review notes
  'writeGoals', // may create and edit goals and actions
  'manage', // may pause, complete, archive, change visibility and sharing
  'review', // may submit a coach review
  'reflect', // may submit a player or guardian reflection
  'linkEvidence', // may attach an evidence reference
]);

const NONE = Object.freeze({
  read: false,
  readInternal: false,
  writeGoals: false,
  manage: false,
  review: false,
  reflect: false,
  linkEvidence: false,
});

const caps = (o) => Object.freeze({ ...NONE, ...o });

export function viewerFor({ player = null, guardian = null, org = null, orgUser = null, grassroots = false } = {}) {
  if (player) return { kind: 'player_self', playerId: player.id, isMinor: !!player.isMinor };
  if (guardian) return { kind: 'guardian', guardianId: guardian.id, childIds: guardian.childIds ?? [] };
  if (org) return { kind: grassroots ? 'grassroots_staff' : 'org_staff', org, orgUser, isLead: !!orgUser?.lead };
  return { kind: 'none' };
}

/** `orgCanSee` is passed in so this stays a pure function. */
export function planAccess(viewer, plan, { player, orgCanSee, isLead = () => false } = {}) {
  if (!viewer || !plan || !player) return NONE;
  if (plan.playerId !== player.id) return NONE;

  switch (viewer.kind) {
    case 'player_self':
      return playerAccess(viewer, plan, player);
    case 'guardian':
      return guardianAccess(viewer, plan, player);
    case 'org_staff':
    case 'grassroots_staff':
      return orgAccess(viewer, plan, player, { orgCanSee, isLead });
    default:
      return NONE;
  }
}

/**
 * A minor only reads their own plan: under the safeguarding model a minor's
 * record-changing actions run through the guardian.
 */
function playerAccess(viewer, plan, player) {
  if (viewer.playerId !== plan.playerId) return NONE;
  const minor = !!player.isMinor;

  if (plan.owner.kind === 'player') {
    if (minor) return caps({ read: true });
    return caps({
      read: true,
      writeGoals: true,
      manage: true,
      reflect: true,
      linkEvidence: true,
    });
  }

  // A club's plan: readable only when the club made it visible; an adult may reflect but not edit.
  if (plan.visibility !== 'player_guardian') return NONE;
  return caps({ read: true, reflect: !minor });
}

function guardianAccess(viewer, plan, player) {
  if (!viewer.childIds?.includes(plan.playerId)) return NONE;
  // An adult's guardian has no access, whatever the stored child list says.
  if (!player.isMinor) return NONE;

  if (plan.owner.kind === 'player') {
    return caps({ read: true, writeGoals: true, manage: true, reflect: true, linkEvidence: true });
  }
  if (plan.visibility !== 'player_guardian') return NONE;
  return caps({ read: true, reflect: true });
}

/**
 * `orgCanSee` is the same live gate search and Rooms use, so a block removes
 * access everywhere at once. `manage` is for leads, as archiving a Room is.
 */
function orgAccess(viewer, plan, player, { orgCanSee, isLead }) {
  const org = viewer.org;
  if (!org) return NONE;
  if (!orgCanSee(org, player)) return NONE;
  const lead = viewer.isLead ?? isLead(viewer.orgUser);

  if (plan.owner.kind === 'org') {
    if (plan.owner.orgId !== org.id) return NONE;
    return caps({
      read: true,
      readInternal: true,
      writeGoals: true,
      manage: lead,
      review: true,
      linkEvidence: true,
    });
  }

  // A player's plan shared with this club: read-only.
  if (plan.visibility !== 'shared_with_org') return NONE;
  if (!(plan.sharedWithOrgIds ?? []).includes(org.id)) return NONE;
  return caps({ read: true });
}

/** Staff may only be assigned on their own organisation's plan, while still staff. */
export function canAssign({ assignee, plan, player, guardianById = () => null, staffById = () => null }) {
  if (!assignee) return { value: null };
  const kind = String(assignee.kind ?? '');

  if (kind === 'player') {
    if (assignee.id !== plan.playerId)
      return { error: 'ASSIGNEE_INVALID', detail: 'Only this plan’s player can be assigned as the player.' };
    return { value: { kind: 'player', id: player.id, name: player.name } };
  }

  if (kind === 'guardian') {
    const found = typeof assignee.id === 'string' ? guardianById(assignee.id) : null;
    const g = found && found.childIds.includes(plan.playerId) ? found : null;
    if (!g) return { error: 'ASSIGNEE_INVALID', detail: 'That guardian does not manage this player.' };
    if (!player.isMinor)
      return {
        error: 'ASSIGNEE_INVALID',
        detail: 'This player is an adult; a guardian cannot be assigned their actions.',
      };
    return { value: { kind: 'guardian', id: g.id, name: g.name ?? null } };
  }

  if (kind === 'org_user') {
    if (plan.owner.kind !== 'org')
      return { error: 'ASSIGNEE_INVALID', detail: 'Club staff can only be assigned actions on a club-owned plan.' };
    const u = staffById(assignee.id);
    if (!u || u.orgId !== plan.owner.orgId || u.removedAt)
      return {
        error: 'ASSIGNEE_INVALID',
        detail: 'That person is not current staff of the organisation that owns this plan.',
      };
    return { value: { kind: 'org_user', id: u.id, name: u.name } };
  }

  return { error: 'ASSIGNEE_INVALID', detail: `Unknown assignee kind "${kind}".` };
}

/**
 * The internal note is a club talking to itself about a player who may read
 * the same record, so it is stripped here on the server, never in a client.
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
  const shared = review.sharedWithPlayerAt ? (review.sharedSummary ?? null) : null;
  return {
    ...base,
    summary: shared,
    internalNote: null,
    // Admits a private note exists without revealing it.
    internalNoteNote: review.internalNote
      ? 'This review also contains notes kept inside the club. They are not shared.'
      : null,
  };
}
