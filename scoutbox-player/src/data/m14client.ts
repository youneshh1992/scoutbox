// M14 player/guardian data surface: SAFE verification badges for clubs, the
// player's structured coach references (with honest provenance wording), and
// squad-invitation acceptance (adults self-serve; minors only via guardian).
// Nothing here exposes evidence, emails or review internals — the server's
// public projector is the only source.
import { m12Request as req } from './httpClient';
import { m14mock } from './m14mock';

const DEMO = process.env.EXPO_PUBLIC_DEMO === '1';

export interface OrgVerBadge { kind: string; label: string; provenance: string; current: boolean; historical: boolean }
export interface OrgVerProfile { organisationStatus: string; identityVerified?: boolean; badges: OrgVerBadge[] }
export interface PlayerReference {
  id: string; version: number; coachName: string; orgName: string; roleAtTime: string | null;
  relationship: string; capacity: string; fromYear: number | null; toYear: number | null;
  structured: { strengths: string; development: string; summary: string };
  status: string; createdAt: number; provenance: string;
}

export interface PlayerM14 {
  orgProfile(playerId: string, orgId: string): Promise<OrgVerProfile>;
  references(playerId: string): Promise<PlayerReference[]>;
  acceptInvite(playerId: string, code: string): Promise<{ note: string }>;
  gOrgProfile(guardianId: string, orgId: string): Promise<OrgVerProfile>;
  gChildReferences(guardianId: string, childId: string): Promise<PlayerReference[]>;
  gAcceptInvite(guardianId: string, childId: string, code: string): Promise<{ note: string }>;
}

const live: PlayerM14 = {
  orgProfile: (playerId, orgId) => req(`/player/verification/org/${orgId}`, playerId),
  references: async (playerId) => (await req<{ items: PlayerReference[] }>('/player/references', playerId)).items,
  acceptInvite: (playerId, code) => req('/player/invites/accept', playerId, { method: 'POST', body: JSON.stringify({ code }) }),
  gOrgProfile: (guardianId, orgId) => req(`/guardian/verification/org/${orgId}`, guardianId),
  gChildReferences: async (guardianId, childId) => (await req<{ items: PlayerReference[] }>(`/guardian/children/${childId}/references`, guardianId)).items,
  gAcceptInvite: (guardianId, childId, code) => req('/guardian/invites/accept', guardianId, { method: 'POST', body: JSON.stringify({ code, childId }) }),
};

export const m14: PlayerM14 = DEMO ? m14mock : live;
