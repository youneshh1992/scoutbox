// M16 demo mirror (org side). Coaches see Box Training assignment results —
// never raw footage. Same honesty rules as live.
import type { M16Api, BoxAssignments, BoxAssignmentRow, BoxDrill, BoxChallengeRow } from './m16api';

const DRILLS: BoxDrill[] = [
  { id: 'box-control', title: 'Box Control', category: 'close_control', summary: 'Close-control movement inside a defined area.', targetTypes: ['duration'], verificationCapabilities: ['player_presence', 'ball_presence', 'active_duration'], repSupport: 'configured', repSupportNote: null },
  { id: 'box-touches', title: 'Box Touches', category: 'ball_mastery', summary: 'Alternating-foot touches.', targetTypes: ['repetitions', 'duration'], verificationCapabilities: ['player_presence', 'ball_presence', 'active_duration', 'rep_count'], repSupport: 'configured', repSupportNote: null },
  { id: 'box-wall', title: 'Box Wall', category: 'passing', summary: 'Wall passes.', targetTypes: ['repetitions'], verificationCapabilities: ['player_presence', 'ball_presence', 'active_duration'], repSupport: 'not_configured', repSupportNote: 'Automated wall-pass rep counting is not configured for a single camera angle — Box Cam verifies active time.' },
  { id: 'box-mobility', title: 'Box Mobility', category: 'mobility', summary: 'Bodyweight mobility.', targetTypes: ['duration'], verificationCapabilities: ['player_presence', 'active_duration'], repSupport: 'configured', repSupportNote: null },
];

const rows: BoxAssignmentRow[] = [
  { id: 'boxa-d1', playerId: 'pl-adeyemi', orgName: 'Eastport United FC', drillId: 'box-wall', drillTitle: 'Box Wall', target: { type: 'repetitions', value: 150 }, frequencyPerWeek: 3, dueDate: null, instructions: 'Weak-foot passes.', state: 'partially_completed', sessionsCompleted: 2, lastResult: { verifiedActive: '9:12', verifiedReps: null, targetCompleted: false, verificationState: 'partially_verified', statusLabel: 'Target not yet completed' } },
  { id: 'boxa-d2', playerId: 'pl-adeyemi', orgName: 'Eastport United FC', drillId: 'box-control', drillTitle: 'Box Control', target: { type: 'duration', value: 1200000 }, frequencyPerWeek: 2, dueDate: null, instructions: 'Both feet.', state: 'completed', sessionsCompleted: 2, lastResult: { verifiedActive: '20:13', verifiedReps: null, targetCompleted: true, verificationState: 'verified', statusLabel: 'Completed' } },
  { id: 'boxa-d3', playerId: 'pl-adeyemi', orgName: 'Eastport United FC', drillId: 'box-mobility', drillTitle: 'Box Mobility', target: { type: 'duration', value: 600000 }, frequencyPerWeek: 2, dueDate: null, instructions: null, state: 'completed', sessionsCompleted: 1, lastResult: { verifiedActive: '10:13', verifiedReps: null, targetCompleted: true, verificationState: 'verified', statusLabel: 'Completed' } },
  { id: 'boxa-d4', playerId: 'pl-adeyemi', orgName: 'Eastport United FC', drillId: 'box-touches', drillTitle: 'Box Touches', target: { type: 'repetitions', value: 250 }, frequencyPerWeek: 3, dueDate: null, instructions: null, state: 'assigned', sessionsCompleted: 0, lastResult: null },
];

export const demoM16: M16Api = {
  drills: async () => DRILLS,
  assignments: async (_s, playerId) => {
    const items = rows.filter((r) => !playerId || r.playerId === playerId);
    return {
      items,
      summary: { assigned: items.length, completed: items.filter((r) => r.state === 'completed').length, partial: items.filter((r) => r.state === 'partially_completed').length, notStarted: items.filter((r) => ['assigned', 'accepted'].includes(r.state)).length },
      note: 'Coaches receive Box Session results. Raw home footage is never captured or shared by Box Cam.',
    } as BoxAssignments;
  },
  createAssignment: async (_s, input) => {
    const drill = DRILLS.find((d) => d.id === input.drillId) ?? DRILLS[0];
    const row: BoxAssignmentRow = { id: `boxa-${Math.random().toString(36).slice(2, 7)}`, playerId: input.playerId, orgName: 'Eastport United FC', drillId: drill.id, drillTitle: drill.title, target: input.target, frequencyPerWeek: input.frequencyPerWeek ?? null, dueDate: input.dueDate ?? null, instructions: input.instructions ?? null, state: 'assigned', sessionsCompleted: 0, lastResult: null };
    rows.unshift(row);
    return { assignment: row };
  },
  cancelAssignment: async (_s, id) => { const r = rows.find((x) => x.id === id)!; r.state = 'cancelled'; return { assignment: r }; },
  challenges: async () => ([{ id: 'boxc-d2', title: 'Eastport United Close Control Box Challenge', drillTitle: 'Box Control', metric: 'active_minutes', targetTotal: 60, startsAt: Date.now() - 2 * 86400000, endsAt: Date.now() + 12 * 86400000, participants: 18 }] as BoxChallengeRow[]),
  createChallenge: async (_s, input) => ({ challenge: { id: `boxc-${Math.random().toString(36).slice(2, 7)}`, title: input.title, drillTitle: DRILLS.find((d) => d.id === input.drillId)?.title ?? input.drillId, metric: input.metric, targetTotal: input.targetTotal, startsAt: Date.now(), endsAt: Date.now() + input.days * 86400000, participants: 0 } }),
};
