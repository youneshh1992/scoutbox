// The synthetic population the data-layer measurements share: organisations (one in seven an agency), three staff per
// organisation, guardians, and players (one in three a minor with a guardian) in the shapes the server writes.
// Synthetic ids and names only: `org-<i>`, `usr-<i>` (staff i belongs to org i mod orgs), `gd-<i>`, `pl-<i>`.
const DAY = 86_400_000;
const pick = (arr, i) => arr[i % arr.length];

export function syntheticPopulation({ players: PLAYERS, now = Date.now() }) {
  const ORGS = Math.max(10, Math.round(PLAYERS / 20));
  const GUARDIANS = Math.round(PLAYERS / 3);
  const orgs = Array.from({ length: ORGS }, (_, i) => ({
    id: `org-${i}`, name: `Club ${i}`, type: i % 7 === 0 ? 'agency' : 'club', level: i % 7 === 0 ? 'agency' : pick(['pro', 'academy', 'grassroots'], i),
    plan: i % 7 === 0 ? 'Agency' : pick(['Pro', 'Academy', 'Grassroots'], i), country: 'GB', location: { lat: 51 + i / 1000, lng: -1 + i / 1000, city: `Town ${i}` },
    verified: i % 3 === 0, safeguardingContractSigned: i % 3 === 0, trustedPartner: false, password: 'scrypt$ab$cd',
  }));
  const users = Array.from({ length: ORGS * 3 }, (_, i) => ({ id: `usr-${i}`, orgId: `org-${i % ORGS}`, name: `Staff ${i}`, role: i % 3 ? 'Scout' : 'Head of Recruitment', createdAt: now - i * 1000 }));
  const guardians = Array.from({ length: GUARDIANS }, (_, i) => ({ id: `gd-${i}`, name: `Guardian ${i}`, email: `g${i}@example.com`, emailVerified: true, idVerified: true, disclaimerAccepted: true, childIds: [] }));
  const players = Array.from({ length: PLAYERS }, (_, i) => {
    const minor = i % 3 === 0;
    const guardianId = minor ? `gd-${i % GUARDIANS}` : null;
    if (guardianId) guardians[i % GUARDIANS].childIds.push(`pl-${i}`);
    return {
      id: `pl-${i}`, name: `Player ${i}`, dob: minor ? '2011-05-05' : '1999-05-05', country: pick(['GB', 'PT', 'FR', 'NG'], i), city: `Town ${i % ORGS}`,
      position: pick(['GK', 'CB', 'CM', 'ST', 'LW'], i), foot: pick(['left', 'right'], i), heightCm: 160 + (i % 30), weightKg: 55 + (i % 30),
      stats: { appearances: i % 40, goals: i % 15, assists: i % 9, paceKmh: 28 + (i % 7), passCompletionPct: 60 + (i % 35), duelSuccessPct: 40 + (i % 50) },
      seasonHistory: [{ season: '2024/25', appearances: 20, goals: 3, assists: 2 }], academyPlus: i % 5 === 0, badges: ['Fresh Start'],
      availability: pick(['available_now', 'end_of_season', 'not_seeking'], i), contractStatus: 'unknown', identityVerified: i % 2 === 0,
      // A fixture holds a squad's worth of players (not the whole population), and one clip in four is playable.
      attendance: [{ id: `att-${i}`, fixture: `Match ${i % Math.max(1, Math.round(PLAYERS / 30))}`, venue: 'Ground', date: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}`, gps: { lat: 51.5, lng: -0.1 }, verified: true }],
      timeline: [{ year: '2024', event: 'Joined' }], media: [{ id: `media-${i}`, title: 'Clip', kind: 'video', uploadedAt: new Date(now - (i % 30) * DAY).toISOString(), url: i % 4 === 0 ? `https://media.example/clip-${i}` : null, views: i % 97, tags: {}, verifiedClip: null }],
      trialReports: [], medical: { shared: false, records: [], conditionStatus: 'unknown' }, guardianId, drills: [], drillResults: [],
      activityLog: [now - DAY, now], createdAt: now - (i % 60) * DAY, password: minor ? null : 'scrypt$ab$cd', level: 'amateur', location: { lat: 51.5, lng: -0.1 },
      notificationPrefs: null, firstTeamSeeker: false, programme: null, // the defaults the boot writes (server.mjs) where a record lacks them
    };
  });
  return { orgs, users, guardians, players, counts: { orgs: ORGS, guardians: GUARDIANS, players: PLAYERS } };
}
