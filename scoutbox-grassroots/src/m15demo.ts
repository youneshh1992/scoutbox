// M15 demo mirror (org side). Same honesty rules as the live projection:
// every item carries provenance; own-org assessments/trials only; the
// player's private layers (objectives, conflicts, prefs) never appear.
import type { FpSummary, M15Api, RecruitmentPassport } from './m15api';

const CLUB_COPY = 'Confirmed by an authorised administrator of the named organisation.';
const PLAYER_COPY = 'Provided by the player. ScoutBox has not independently confirmed this item.';
const COACH_COPY = 'Confirmed by a coach whose club affiliation was verified when they confirmed it.';

const PASSPORTS: Record<string, RecruitmentPassport> = {
  'pl-adeyemi': {
    viewer: 'pro_club',
    player: { id: 'pl-adeyemi', name: 'Kola Adeyemi', age: 24, position: 'ST', location: 'Manchester', level: 'semi_pro' },
    identity: { confirmed: true, assurance: 'scoutbox_document_review', label: 'Identity confirmed by ScoutBox review' },
    status: { currentClub: { orgName: 'Eastport United FC', role: null, since: '2026-05', provenance: 'verified_club_confirmed' }, availability: 'open_to_trials', representation: null },
    note: 'A Football Passport describes evidence and provenance. It is not a rating of football ability and not a ScoutBox endorsement.',
    timeline: [
      { id: 'pev:signing:d1:signed', type: 'signed', when: { display: '2026-05-02', precision: 'day' }, title: { org: 'Eastport United FC' }, org: { id: 'org-eastport', name: 'Eastport United FC' }, provenance: 'verified_club_confirmed', provenanceCopy: CLUB_COPY },
      { id: 'pev:reference:d2:reference_received', type: 'reference_received', when: { display: '2026-03-14', precision: 'day' }, title: { coach: 'Tom Field' }, org: { id: 'org-eastport', name: 'Eastport United FC' }, provenance: 'verified_coach_confirmed', provenanceCopy: COACH_COPY },
      { id: 'pev:evidence:d3:evidence_added', type: 'evidence_added', when: { display: '2026-01-11', precision: 'day' }, title: { label: 'Full match vs Harbour U23' }, org: null, provenance: 'player_submitted', provenanceCopy: PLAYER_COPY },
      { id: 'pev:career:d4:club_joined', type: 'club_joined', when: { display: '2018', precision: 'year' }, title: { org: 'Sunday Kings FC' }, org: { id: null, name: 'Sunday Kings FC' }, provenance: 'player_submitted', provenanceCopy: PLAYER_COPY },
    ],
    clubHistory: [
      { orgName: 'Eastport United FC', role: null, from: '2026-05-02', to: null, current: true, provenance: 'verified_club_confirmed', provenanceCopy: CLUB_COPY },
      { orgName: 'Sunday Kings FC', role: 'ST', from: '2018', to: null, current: false, provenance: 'player_submitted', provenanceCopy: PLAYER_COPY },
    ],
    evidence: { fullMatches: 1, clips: 2, assessments: 1, references: 2, lastEvidenceDays: 12, note: 'Counts describe evidence coverage, not football ability.' },
    references: [{
      id: 'dref-1', coachName: 'Tom Field', roleAtTime: 'Academy Scout', orgName: 'Eastport United FC',
      relationship: 'Scouted and coached at development camp', fromYear: 2024, toYear: 2026, at: '2026-03-14',
      provenance: 'verified_coach_confirmed', provenanceCopy: "Coach's Eastport United FC affiliation is verified.",
      structured: { strengths: 'Pressing triggers', development: 'Weak-foot delivery', summary: 'Reliable, coachable forward.' },
    }],
    achievements: [
      { id: 'dach-1', title: 'County Cup Winner 2024', orgName: 'Eastport United FC', when: '2024', provenance: 'verified_club_confirmed', confirmedBy: 'Eastport United FC', provenanceCopy: CLUB_COPY },
      { id: 'dach-2', title: 'League top scorer 2025', orgName: null, when: '2025', provenance: 'player_submitted', confirmedBy: null, provenanceCopy: PLAYER_COPY },
    ],
    assessments: [{ id: 'dass-1', org: 'Eastport United FC', at: '2026-02-20', state: 'submitted' }],
    trials: [{ id: 'dtr-1', org: 'Eastport United FC', date: '2026-02-01', hasReport: true }],
    availability: 'open_to_trials',
    representation: null,
  },
};

const SUMMARIES: FpSummary[] = [
  { playerId: 'pl-adeyemi', position: 'ST', age: 24, currentClub: { name: 'Eastport United FC', provenance: 'verified_club_confirmed' }, evidenceCoverage: 'strong', lastEvidenceDays: 12, references: 2, availability: 'open_to_trials', identityConfirmed: true },
  { playerId: 'pl-svensson', position: 'RW', age: 19, currentClub: null, evidenceCoverage: 'moderate', lastEvidenceDays: 34, references: 1, availability: null, identityConfirmed: true },
  { playerId: 'pl-carvalho', position: 'CM', age: 22, currentClub: null, evidenceCoverage: 'limited', lastEvidenceDays: null, references: 0, availability: null, identityConfirmed: false },
];

export const demoM15: M15Api = {
  passport: async (_s, playerId) => {
    const p = PASSPORTS[playerId];
    if (!p) return { ...PASSPORTS['pl-adeyemi'], player: { ...PASSPORTS['pl-adeyemi'].player, id: playerId, name: 'Demo player' } };
    return p;
  },
  summaries: async (_s, ids) => SUMMARIES.filter((x) => ids.includes(x.playerId)),
  confirmAchievement: async () => undefined,
  openShared: async () => ({ ...PASSPORTS['pl-adeyemi'], shareMode: 'recruitment' }),
};
