/** A federation group's resource grant, as its members and the enterprise export see it. */
export const grantView = (gr) => ({
  id: gr.id,
  groupId: gr.groupId,
  fromOrgId: gr.fromOrgId,
  fromOrgName: gr.fromOrgName,
  toOrgIds: [...gr.toOrgIds],
  resourceKind: gr.resourceKind,
  resourceId: gr.resourceId,
  expiresAt: gr.expiresAt,
  revokedAt: gr.revokedAt,
  revokeReason: gr.revokeReason,
  createdBy: gr.createdBy,
  createdAt: gr.createdAt,
});
