// M15 demo mirror. Honesty rules match the live server exactly: every item
// carries provenance and its plain-language copy; player-submitted history is
// labelled as such; a flagged current-club conflict shows how the passport
// EXPLAINS instead of silently overwriting; nothing is a score.
import type { FootballPassport, PassportActor, PassportShare, PlayerM15 } from './m15client';

const now = Date.now();
const day = 86_400_000;

const COPY = {
  player: 'Provided by the player. ScoutBox has not independently confirmed this item.',
  guardian: 'Provided by the player’s guardian. ScoutBox has not independently confirmed this item.',
  club: 'Confirmed by an authorised administrator of the named organisation.',
  coach: 'Confirmed by a coach whose club affiliation was verified when they confirmed it.',
};

function demoPassport(a: PassportActor): FootballPassport {
  const child = a.kind === 'guardian';
  return {
    viewer: child ? 'guardian' : 'self',
    player: child
      ? { id: 'pl-guni', name: 'Guni Adebayo', age: 14, position: 'RW', location: 'London', level: 'amateur' }
      : { id: 'pl-adeyemi', name: 'Kola Adeyemi', age: 24, position: 'ST', location: 'Manchester', level: 'semi_pro' },
    identity: { confirmed: true, assurance: 'scoutbox_document_review', label: 'Identity confirmed by ScoutBox review' },
    status: {
      currentClub: child
        ? null
        : { orgName: 'Eastport United FC', role: null, since: '2026-05', provenance: 'verified_club_confirmed' },
      positions: { primary: child ? 'RW' : 'ST', secondary: child ? [] : ['RW'] },
      availability: child ? null : 'open_to_trials',
      availableFrom: null,
      representation: null,
    },
    note: 'A Football Passport describes evidence and provenance. It is not a rating of football ability and not a ScoutBox endorsement.',
    timeline: [
      { id: 'pev:signing:d1:signed', type: 'signed', when: { display: '2026-05-02', precision: 'day' }, title: { org: 'Eastport United FC' }, org: { id: 'org-eastport', name: 'Eastport United FC' }, provenance: 'verified_club_confirmed', provenanceCopy: COPY.club },
      { id: 'pev:reference:d2:reference_received', type: 'reference_received', when: { display: '2026-03-14', precision: 'day' }, title: { coach: 'Tom Field', org: 'Eastport United FC' }, org: { id: 'org-eastport', name: 'Eastport United FC' }, provenance: 'verified_coach_confirmed', provenanceCopy: COPY.coach },
      { id: 'pev:trial:d3:trial_attended', type: 'trial_attended', when: { display: '2026-02-20', precision: 'day' }, title: { org: 'Eastport United FC' }, org: { id: 'org-eastport', name: 'Eastport United FC' }, provenance: 'verified_club_confirmed', provenanceCopy: COPY.club },
      { id: 'pev:evidence:d4:evidence_added', type: 'evidence_added', when: { display: '2026-01-11', precision: 'day' }, title: { label: 'Full match vs Harbour U23' }, org: null, provenance: 'player_submitted', provenanceCopy: COPY.player },
      { id: 'pev:career:d5:club_joined', type: 'club_joined', when: { display: '2018', precision: 'year' }, title: { org: 'Sunday Kings FC', role: 'ST' }, org: { id: null, name: 'Sunday Kings FC' }, provenance: child ? 'guardian_submitted' : 'player_submitted', provenanceCopy: child ? COPY.guardian : COPY.player },
    ],
    clubHistory: [
      ...(child ? [] : [{ orgName: 'Eastport United FC', role: null, from: '2026-05-02', to: null, current: true, provenance: 'verified_club_confirmed', provenanceCopy: COPY.club }]),
      { orgName: 'Sunday Kings FC', role: 'ST', from: '2018', to: null, current: child, provenance: child ? 'guardian_submitted' : 'player_submitted', provenanceCopy: child ? COPY.guardian : COPY.player },
    ],
    foldedConflicts: [],
    conflicts: child ? [] : [{ code: 'CURRENT_CLUB_CONFLICT', authoritative: { orgName: 'Eastport United FC' }, submitted: { orgName: 'Sunday Kings FC' } }],
    temporalConflicts: [],
    evidence: { fullMatches: 1, clips: 2, assessments: child ? 0 : 1, references: child ? 1 : 2, lastEvidenceDays: 12, note: 'Counts describe evidence coverage, not football ability.' },
    references: [{
      id: 'dref-1', coachName: 'Tom Field', roleAtTime: 'Academy Scout', orgName: 'Eastport United FC',
      relationship: 'Scouted and coached at development camp', fromYear: 2024, toYear: 2026, at: '2026-03-14',
      provenance: 'verified_coach_confirmed', provenanceCopy: "Coach's Eastport United FC affiliation is verified.",
      structured: { strengths: 'Pressing triggers', development: 'Weak-foot delivery', summary: 'Reliable, coachable forward.' },
    }],
    achievements: [
      { id: 'dach-1', title: 'County Cup Winner 2024', orgName: 'Eastport United FC', when: '2024', provenance: 'verified_club_confirmed', confirmedBy: 'Eastport United FC', provenanceCopy: COPY.club, withdrawable: false },
      { id: 'dach-2', title: 'U15 league top scorer', orgName: null, when: '2026', provenance: child ? 'guardian_submitted' : 'player_submitted', confirmedBy: null, provenanceCopy: child ? COPY.guardian : COPY.player, withdrawable: true },
    ],
    development: { active: 1, completed: 1 },
    trials: { total: 1, withReport: 1 },
    completeness: {
      evidenceCoverage: child ? 'moderate' : 'strong',
      gaps: child
        ? [{ id: 'gap.assessment_recent', version: 1, category: 'assessments' }, { id: 'gap.availability_set', version: 1, category: 'availability' }]
        : [{ id: 'gap.assessment_recent', version: 1, category: 'assessments' }],
      eligibility: { satisfied: child ? 6 : 7, total: 8, rulesVersion: 1, missing: child ? ['gap.assessment_recent', 'gap.availability_set'] : ['gap.assessment_recent'] },
    },
    sharing: { active: 1 },
    prefs: { bio: null, positions: { primary: child ? 'RW' : 'ST', secondary: [] }, availability: child ? null : 'open_to_trials', availableFrom: null, publicSelections: [] },
  };
}

const demoShares: PassportShare[] = [
  { id: 'dshr-1', mode: 'public', createdAt: now - 5 * day, expiresAt: now + 25 * day, revokedAt: null, views: 7, createdBy: 'player' },
];

export const m15mock: PlayerM15 = {
  passport: async (a) => demoPassport(a),
  patchPrefs: async () => undefined,
  addCareer: async () => ({ provenance: 'player_submitted', note: 'Demo: recorded as provided by the player — ScoutBox has not independently confirmed it.' }),
  withdrawCareer: async () => undefined,
  addAchievement: async () => undefined,
  withdrawAchievement: async () => undefined,
  fileCorrection: async () => ({ note: 'Demo: Trust & Safety reviews correction requests — records are never silently edited.' }),
  shares: async () => demoShares,
  createShare: async (_a, mode) => ({
    share: { id: 'dshr-new', mode, createdAt: now, expiresAt: now + 30 * day, revokedAt: null, views: 0, createdBy: 'player' },
    url: mode === 'public' ? '/passport/shared/demo-secret' : '/org/passport/shared/demo-secret',
    note: mode === 'public' ? 'Anyone with the link sees the SAFE PUBLIC projection only.' : 'The link opens only inside an authenticated club session — a share never widens access.',
  }),
  revokeShare: async () => undefined,
};
