// M14 demo mirror for the player app. Honesty rules match the live server:
// club badges name the verified fact and its provenance; one reference shows
// the "verified when submitted" wording for a coach who has since moved on.
import type { PlayerM14, OrgVerProfile, PlayerReference } from './m14client';

const now = Date.now();
const day = 86_400_000;

const ORG_PROFILES: Record<string, OrgVerProfile> = {
  'org-eastport': {
    organisationStatus: 'verified',
    badges: [{ kind: 'organisation', label: 'Verified organisation', provenance: 'Reviewed and confirmed by ScoutBox Trust & Safety', current: true, historical: false }],
  },
  'org-hackneymarsh': {
    organisationStatus: 'verified',
    badges: [{ kind: 'organisation', label: 'Verified organisation', provenance: 'Reviewed and confirmed by ScoutBox Trust & Safety', current: true, historical: false }],
  },
};

const REFERENCES: Record<string, PlayerReference[]> = {
  'pl-adeyemi': [
    {
      id: 'dref-1', version: 2, coachName: 'Tom Field', orgName: 'Eastport United', roleAtTime: 'Academy Scout',
      relationship: 'Scouted and coached at development camp', capacity: '2 seasons', fromYear: 2024, toYear: 2026,
      structured: { strengths: 'Pressing triggers, first touch under pressure', development: 'Weak-foot delivery', summary: 'Reliable, coachable wide forward with excellent pressing.' },
      status: 'active', createdAt: now - 30 * day,
      provenance: "Coach's Eastport United affiliation is verified.",
    },
    {
      id: 'dref-2', version: 1, coachName: 'Priya Nair', orgName: 'Eastport United', roleAtTime: 'Academy Coach',
      relationship: 'Academy coach, U16 group', capacity: '1 season', fromYear: 2022, toYear: 2023,
      structured: { strengths: 'Composure in tight spaces', development: 'Aerial duels', summary: 'Composed left-sided attacker; trains with intent.' },
      status: 'active', createdAt: now - 700 * day,
      provenance: 'Coach affiliation was verified when this reference was submitted.',
    },
  ],
  'pl-guni': [],
};

export const m14mock: PlayerM14 = {
  orgProfile: async (_p, orgId) => ORG_PROFILES[orgId] ?? { organisationStatus: 'unverified', badges: [] },
  references: async (playerId) => REFERENCES[playerId] ?? [],
  acceptInvite: async () => ({ note: 'Demo: invitation accepted. Joining links nothing else — safeguarding rules are unchanged.' }),
  gOrgProfile: async (_g, orgId) => ORG_PROFILES[orgId] ?? { organisationStatus: 'unverified', badges: [] },
  gChildReferences: async () => [{
    id: 'dref-kid', version: 1, coachName: 'Dee Coach', orgName: 'Hackney Marsh Rovers', roleAtTime: 'Youth Coach',
    relationship: 'Club coach, U17s', capacity: '1 season', fromYear: 2025, toYear: 2026,
    structured: { strengths: 'Work rate, positioning', development: 'Communication on pitch', summary: 'Committed central midfielder.' },
    status: 'active', createdAt: now - 12 * day,
    provenance: "Coach's Hackney Marsh Rovers affiliation is verified.",
  }],
  gAcceptInvite: async () => ({ note: 'Demo: guardian approval recorded. The club gains no control over the profile.' }),
};
