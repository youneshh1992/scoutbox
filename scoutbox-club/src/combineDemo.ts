// M16.1 demo mirror (org side). A coach requests standardized Combine tests
// and reads Combine Verified RESULTS — never raw footage. Missing results are
// blank (never 0) and there is no overall ranking. Same honesty rules as live.
import type { CombineApi, CombineRequestRow, CompareMatrix, PlayerCombine, CombineResult } from './combineApi';
import { STANDARD_PROTOCOLS } from './combineApi';

const now = Date.now();
const day = 86_400_000;
const fmt = (id: string, v: number) => id === 'combine-box-control-60' ? v.toFixed(1) : `${Math.round(v)}`;
const title = (id: string) => STANDARD_PROTOCOLS.find((p) => p.id === id)?.title ?? id;
const unit = (id: string) => STANDARD_PROTOCOLS.find((p) => p.id === id)?.metricUnit ?? '';

const result = (id: string, value: number, ageDays: number): CombineResult => ({
  protocolId: id, protocolVersion: 1, protocolTitle: title(id), metricUnit: unit(id),
  measuredValue: value, display: fmt(id, value), combineVerified: true, capturedBy: 'box_cam', completedAt: now - ageDays * day,
});

// Verified results by player. Kola mirrors the player-app demo fixture; Elias
// has only one shared result, so the comparison shows honest blank cells.
const RESULTS: Record<string, CombineResult[]> = {
  'pl-adeyemi': [result('combine-box-touch-60', 184, 3), result('combine-box-juggle', 87, 6), result('combine-box-control-60', 57.4, 9)],
  'pl-svensson': [result('combine-box-touch-60', 171, 4)],
};
const NAMES: Record<string, string> = { 'pl-adeyemi': 'Kola Adeyemi', 'pl-svensson': 'Elias Svensson' };

const requests: CombineRequestRow[] = [
  {
    id: 'creq-d1', orgId: 'org-demo', orgName: 'Eastport United FC', title: 'Autumn At-Home Combine',
    requestedBy: { userId: 'u-demo', name: 'A. Coach', role: 'Head of Recruitment', at: now - 2 * day },
    playerId: 'pl-adeyemi',
    protocols: [
      { protocolId: 'combine-box-touch-60', protocolTitle: 'Box Touch 60', completed: true },
      { protocolId: 'combine-box-control-60', protocolTitle: 'Box Control 60', completed: false },
    ],
    deadline: new Date(now + 12 * day).toISOString().slice(0, 10),
    instructions: 'Portrait for touches, landscape for control. Powered by Box Cam.',
    state: 'requested', createdAt: now - 2 * day, completedCount: 1, requiredCount: 2,
    note: 'Completing a Club Combine means the standardized tests were completed and Combine Verified. It does not mean the club has selected, endorsed or rejected the player.',
  },
];

export const demoCombine: CombineApi = {
  standardProtocols: () => STANDARD_PROTOCOLS,
  createRequest: async (_s, input) => {
    const playerIds = input.playerIds && input.playerIds.length ? input.playerIds : (input.playerId ? [input.playerId] : []);
    const created: CombineRequestRow[] = [];
    for (const pid of playerIds) {
      const row: CombineRequestRow = {
        id: `creq-${Math.random().toString(36).slice(2, 7)}`, orgId: 'org-demo', orgName: 'Eastport United FC',
        title: input.title ?? null, requestedBy: { userId: 'u-demo', name: 'A. Coach', role: 'Head of Recruitment', at: now },
        playerId: pid,
        protocols: input.protocolIds.map((id) => ({ protocolId: id, protocolTitle: title(id), completed: false })),
        deadline: input.deadline ?? null, instructions: input.instructions ?? null,
        state: 'requested', createdAt: now, completedCount: 0, requiredCount: input.protocolIds.length,
        note: 'Completing a Club Combine means the standardized tests were completed and Combine Verified. It does not mean the club has selected, endorsed or rejected the player.',
      };
      requests.unshift(row);
      created.push(row);
    }
    return { requests: created, skipped: [] };
  },
  requests: async (_s, playerId) => requests.filter((r) => (!playerId || r.playerId === playerId) && r.state !== 'cancelled'),
  cancelRequest: async (_s, id) => { const r = requests.find((x) => x.id === id)!; r.state = 'cancelled'; return { request: r }; },
  player: async (_s, playerId): Promise<PlayerCombine> => {
    const results = RESULTS[playerId];
    if (!results) return { playerId, shared: false, results: [], note: 'This player has not shared Combine results with your organisation. Request an At-Home Combine or ask them to share development activity.' };
    return { playerId, playerName: NAMES[playerId], shared: true, results, hasCombineVerifiedResults: results.length > 0, note: 'Combine Verified: measured from a standardized ScoutBox protocol during a live Box Cam session. Powered by Box Cam. Real numbers, not a talent score.' };
  },
  compare: async (_s, playerIds, protocols): Promise<CompareMatrix> => {
    const protoIds = protocols && protocols.length ? protocols : STANDARD_PROTOCOLS.map((p) => p.id);
    const cols = protoIds.map((id) => ({ id, version: 1, title: title(id), metricUnit: unit(id), direction: id === 'combine-agility-5-10-5' ? 'lower' : 'higher' }));
    return {
      protocols: cols,
      rows: playerIds.filter((pid) => RESULTS[pid]).map((pid) => ({
        playerId: pid, playerName: NAMES[pid] ?? pid,
        cells: cols.map((c) => {
          const r = RESULTS[pid].find((x) => x.protocolId === c.id);
          return r ? { value: r.measuredValue, display: r.display, verified: true, at: r.completedAt } : null;
        }),
      })),
      note: 'Verified numbers only (✓). A blank cell means no verified result — not zero. ScoutBox does not rank players overall.',
    };
  },
};
