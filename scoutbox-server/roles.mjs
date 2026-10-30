/**
 * Organisation staff roles — the one definition of the lead tier.
 *
 * ScoutBox stores a staff member's role as free text chosen by the person who
 * provisioned them (the registering administrator, or a lead's invitation).
 * The privileged "lead" tier — approvals, staff management, signings, SSO and
 * audit exports — is derived from that text by a documented pattern.
 *
 * The pattern used to be copied into seven modules. One copy drifting would
 * have meant one route granting lead powers that the others refuse, so the
 * rule lives here and nowhere else. The role text itself is only ever set by
 * server-controlled flows (registration, invitations, the development
 * shortcut on unprovisioned demo organisations); a login never changes it on
 * an organisation that holds real credentials.
 */
export const LEAD_ROLE_PATTERN = /head|director|lead|manager|owner|chief/i;

/** True when a role string belongs to the lead tier. Null/undefined → false. */
export const isLeadRole = (role) => LEAD_ROLE_PATTERN.test(role ?? '');

/** The same test on a staff user record (`{ role }`). */
export const isLeadUser = (user) => isLeadRole(user?.role);
