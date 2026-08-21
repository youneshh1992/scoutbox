// Seed dataset. In-memory only — a server restart resets to this.
// Milestone 3: under-18 players exist, each owned by a verified guardian.
// Agencies never see them; unverified clubs never see them; verified clubs
// contact the guardian, never the child (domain.mjs / visibleToOrg).

export function buildSeed() {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  const orgs = [
    {
      id: 'org-eastport',
      name: 'Eastport FC',
      type: 'club',
      plan: 'Pro',
      trustedPartner: true,
      country: 'GB',
      // Club verification: company-email domain + signed safeguarding contract.
      verified: true,
      verifiedDomain: 'eastportfc.com',
      safeguardingContractSigned: true,
    },
    {
      id: 'org-harbour',
      name: 'Harbour City FC',
      type: 'club',
      plan: 'Academy',
      trustedPartner: false,
      country: 'GB',
      // Verification pending: adults only until the domain check + contract clear.
      verified: false,
      verifiedDomain: null,
      safeguardingContractSigned: false,
    },
    {
      id: 'org-northstar',
      name: 'North Star Sports Agency',
      type: 'agency',
      plan: 'Agency',
      trustedPartner: false,
      country: 'GB',
      verified: false,
      verifiedDomain: null,
      safeguardingContractSigned: false,
    },
  ];

  // Guardians own every under-18 account. Both seeded guardians have already
  // passed ID verification and accepted the safeguarding disclaimer.
  const guardians = [
    {
      id: 'gd-amara',
      name: 'Amara Adebayo',
      email: 'amara.adebayo@example.com',
      password: null, // demo seed — open login; production seeds always set one
      emailVerified: true,
      idVerified: true,
      disclaimerAccepted: true,
      childIds: ['pl-guni'],
    },
    {
      id: 'gd-marek',
      name: 'Marek Kowalski',
      email: 'marek.kowalski@example.com',
      password: null, // demo seed — open login
      emailVerified: true,
      idVerified: true,
      disclaimerAccepted: true,
      childIds: ['pl-tomasz', 'pl-imani'],
    },
  ];

  const players = [
    player({
      id: 'pl-adeyemi',
      name: 'Kola Adeyemi',
      dob: '2004-03-14',
      country: 'GB',
      city: 'Manchester',
      position: 'ST',
      foot: 'right',
      heightCm: 184,
      weightKg: 79,
      squadNumber: 22,
      contractUntil: '2026-06-30',
      marketValueRange: '€250K – €450K',
      agentName: 'Team Elevate',
      seasonHistory: [
        { season: '2024/25', appearances: 27, goals: 14, assists: 4 },
        { season: '2023/24', appearances: 24, goals: 9, assists: 3 },
      ],
      stats: { appearances: 31, goals: 22, assists: 6, paceKmh: 34.1, passCompletionPct: 78, duelSuccessPct: 61 },
      academyPlus: true,
      badges: ['Finisher', 'Pressing Forward'],
      availability: 'available_now',
      contractStatus: 'expiring_summer',
      identityVerified: true,
      attendance: [
        att('Sunday League Cup Final', 'Hough End Playing Fields', now - 20 * day),
        att('County Trial Day', 'Platt Lane Complex', now - 60 * day),
      ],
      timeline: [
        tl('2019', 'Joined local academy U15s'),
        tl('2022', 'Released at 18 — continued in county football'),
        tl('2025', 'Top scorer, county premier division'),
      ],
      media: [
        med('Match highlights vs Riverside', 'video', now - 25 * day),
        med('Sprint & finishing session', 'video', now - 80 * day),
      ],
      medical: {
        shared: false,
        records: [
          { id: 'md-1', type: 'injury', title: 'Hamstring strain (grade 1)', date: '2025-11-02', layoffWeeks: 3, cleared: true },
          { id: 'md-2', type: 'clearance', title: 'Pre-season cardiac screen — clear', date: '2026-01-15', cleared: true },
        ],
        conditionStatus: 'fully_fit',
      },
    }),
    player({
      id: 'pl-carvalho',
      name: 'Mateus Carvalho',
      dob: '2002-07-30',
      country: 'PT',
      city: 'Porto',
      position: 'CM',
      foot: 'left',
      heightCm: 176,
      weightKg: 71,
      stats: { appearances: 28, goals: 4, assists: 11, paceKmh: 31.2, passCompletionPct: 89, duelSuccessPct: 55 },
      academyPlus: true,
      badges: ['Deep Playmaker'],
      availability: 'end_of_season',
      contractStatus: 'under_contract',
      identityVerified: true,
      attendance: [att('District league round 18', 'Campo do Bessa Anexo', now - 12 * day)],
      timeline: [tl('2020', 'Senior debut, district league'), tl('2024', 'Captain at 22')],
      media: [med('Passing range compilation', 'video', now - 40 * day)],
      medical: {
        shared: true,
        records: [{ id: 'md-3', type: 'clearance', title: 'Annual medical — clear', date: '2026-02-01', cleared: true }],
        conditionStatus: 'fully_fit',
      },
    }),
    player({
      id: 'pl-okafor',
      name: 'Chinedu Okafor',
      dob: '2003-11-08',
      country: 'NG',
      city: 'Lagos',
      position: 'CB',
      foot: 'right',
      heightCm: 191,
      weightKg: 85,
      stats: { appearances: 24, goals: 2, assists: 1, paceKmh: 32.8, passCompletionPct: 82, duelSuccessPct: 72 },
      academyPlus: false,
      badges: [],
      availability: 'overseas_open',
      contractStatus: 'free_agent',
      identityVerified: true,
      attendance: [att('NLO fixture, matchday 9', 'Agege Stadium', now - 30 * day)],
      timeline: [tl('2021', 'Nationwide League One debut')],
      media: [med('Defensive duels reel', 'video', now - 55 * day)],
      medical: { shared: false, records: [], conditionStatus: 'fully_fit' },
    }),
    player({
      id: 'pl-svensson',
      name: 'Elias Svensson',
      dob: '2005-01-22',
      country: 'SE',
      city: 'Göteborg',
      position: 'RW',
      foot: 'left',
      heightCm: 178,
      weightKg: 72,
      stats: { appearances: 26, goals: 9, assists: 12, paceKmh: 35.0, passCompletionPct: 81, duelSuccessPct: 49 },
      academyPlus: true,
      badges: ['Direct Winger', 'Fresh Start'],
      availability: 'available_now',
      contractStatus: 'scholarship_ending',
      identityVerified: false,
      attendance: [],
      timeline: [tl('2023', 'Div 2 debut at 18'), tl('2025', 'Released from academy — Academy+ member')],
      media: [med('1v1 and crossing clips', 'video', now - 10 * day)],
      medical: {
        shared: false,
        records: [{ id: 'md-4', type: 'injury', title: 'ACL reconstruction (right)', date: '2024-08-19', layoffWeeks: 38, cleared: true }],
        conditionStatus: 'fully_fit',
      },
    }),
    player({
      id: 'pl-martin',
      name: 'Théo Martin',
      dob: '2001-05-03',
      country: 'FR',
      city: 'Lyon',
      position: 'GK',
      foot: 'right',
      heightCm: 193,
      weightKg: 88,
      stats: { appearances: 33, goals: 0, assists: 0, paceKmh: 29.5, passCompletionPct: 74, duelSuccessPct: 0, cleanSheets: 14 },
      academyPlus: false,
      badges: [],
      availability: 'loan_open',
      contractStatus: 'under_contract',
      identityVerified: true,
      attendance: [att('National 3, round 21', 'Stade de Balmont', now - 8 * day)],
      timeline: [tl('2019', 'Youth international (U18, 2 caps)'), tl('2023', 'N3 first choice')],
      media: [],
      medical: { shared: false, records: [], conditionStatus: 'fully_fit' },
    }),
    player({
      id: 'pl-tanaka',
      name: 'Riku Tanaka',
      dob: '2004-09-17',
      country: 'JP',
      city: 'Osaka',
      position: 'CAM',
      foot: 'right',
      heightCm: 172,
      weightKg: 66,
      stats: { appearances: 29, goals: 11, assists: 9, paceKmh: 32.4, passCompletionPct: 86, duelSuccessPct: 51 },
      academyPlus: false,
      badges: [],
      availability: 'not_seeking',
      contractStatus: 'under_contract',
      identityVerified: true,
      attendance: [att('JFL matchday 4', 'Nagai Aid Stadium', now - 45 * day)],
      timeline: [tl('2022', 'JFL debut')],
      media: [med('Set-piece deliveries', 'video', now - 90 * day)],
      medical: { shared: false, records: [], conditionStatus: 'fully_fit' },
    }),
    player({
      id: 'pl-alvarez',
      name: 'Santiago Álvarez',
      dob: '2003-02-11',
      country: 'AR',
      city: 'Rosario',
      position: 'LB',
      foot: 'left',
      heightCm: 175,
      weightKg: 70,
      stats: { appearances: 27, goals: 1, assists: 7, paceKmh: 33.6, passCompletionPct: 84, duelSuccessPct: 63 },
      academyPlus: true,
      badges: ['Overlapping Full-back'],
      availability: 'overseas_open',
      contractStatus: 'expiring_summer',
      identityVerified: true,
      attendance: [att('Torneo Regional, fecha 12', 'Estadio Gabino Sosa', now - 15 * day)],
      timeline: [tl('2021', 'Regional league debut'), tl('2024', 'Team of the season')],
      media: [med('Crossing under pressure', 'video', now - 33 * day)],
      medical: { shared: false, records: [], conditionStatus: 'fully_fit' },
    }),
    player({
      id: 'pl-nowak',
      name: 'Filip Nowak',
      dob: '2000-12-05',
      country: 'PL',
      city: 'Kraków',
      position: 'CDM',
      foot: 'right',
      heightCm: 183,
      weightKg: 78,
      stats: { appearances: 30, goals: 3, assists: 4, paceKmh: 31.8, passCompletionPct: 88, duelSuccessPct: 68 },
      academyPlus: false,
      badges: [],
      availability: 'end_of_season',
      contractStatus: 'release_approaching',
      identityVerified: true,
      attendance: [att('III liga, round 24', 'Stadion Miejski Wieczysta', now - 5 * day)],
      timeline: [tl('2019', 'Senior debut'), tl('2025', '100th appearance')],
      media: [med('Screening & interceptions', 'video', now - 70 * day)],
      medical: {
        shared: true,
        records: [{ id: 'md-5', type: 'injury', title: 'Ankle syndesmosis sprain', date: '2025-04-10', layoffWeeks: 8, cleared: true }],
        conditionStatus: 'fully_fit',
      },
    }),
    player({
      id: 'pl-mensah',
      name: 'Kwame Mensah',
      dob: '2005-06-28',
      country: 'GH',
      city: 'Kumasi',
      position: 'LW',
      foot: 'right',
      heightCm: 174,
      weightKg: 68,
      stats: { appearances: 22, goals: 8, assists: 5, paceKmh: 34.7, passCompletionPct: 76, duelSuccessPct: 47 },
      academyPlus: true,
      badges: ['Fresh Start'],
      availability: 'available_now',
      contractStatus: 'free_agent',
      identityVerified: false,
      attendance: [],
      timeline: [tl('2023', 'Division One League debut')],
      media: [med('Dribbling sequences', 'video', now - 18 * day)],
      medical: { shared: false, records: [], conditionStatus: 'fully_fit' },
    }),
    player({
      id: 'pl-kim',
      name: 'Kim Min-jae',
      dob: '2006-04-02', // 20 — adult age in KR is 19, so visible to all org types
      country: 'KR',
      city: 'Busan',
      position: 'CF',
      foot: 'right',
      heightCm: 186,
      weightKg: 80,
      stats: { appearances: 19, goals: 13, assists: 2, paceKmh: 33.9, passCompletionPct: 72, duelSuccessPct: 58 },
      academyPlus: false,
      badges: [],
      availability: 'available_now',
      contractStatus: 'free_agent',
      identityVerified: true,
      attendance: [att('K4 League round 7', 'Gudeok Stadium', now - 22 * day)],
      timeline: [tl('2024', 'K4 debut at 18')],
      media: [med('Hold-up play & finishing', 'video', now - 12 * day)],
      medical: { shared: false, records: [], conditionStatus: 'fully_fit' },
    }),
    // ---- Under-18 players: guardian-owned. Invisible to agencies and to
    // unverified clubs; all contact routes to the guardian.
    player({
      id: 'pl-guni',
      name: 'Guni Adebayo',
      dob: '2012-02-10', // 14
      country: 'GB',
      city: 'London', // stripped from every org view for minors
      guardianId: 'gd-amara',
      position: 'RW',
      foot: 'left',
      heightCm: 165,
      weightKg: 54,
      stats: { appearances: 18, goals: 12, assists: 7, paceKmh: 30.2, passCompletionPct: 74, duelSuccessPct: 44 },
      identityVerified: true,
      attendance: [att('U15 Academy League, week 12', 'Hackney Marshes', now - 9 * day)],
      timeline: [tl('2024', 'Joined grassroots academy U13s'), tl('2026', 'U15 league top scorer at 14')],
      media: [med('U15 highlights — wing play', 'video', now - 14 * day)],
      medical: { shared: false, records: [], conditionStatus: 'fully_fit' },
    }),
    // Turned 18 recently but the account is still guardian-linked — the
    // aging-up transition flow hands ownership to the player.
    player({
      id: 'pl-imani',
      name: 'Imani Kowalska',
      dob: '2008-07-15', // just turned 18
      country: 'PL',
      city: 'Gdańsk',
      guardianId: 'gd-marek',
      position: 'ST',
      foot: 'right',
      heightCm: 172,
      weightKg: 65,
      stats: { appearances: 19, goals: 11, assists: 3, paceKmh: 32.1, passCompletionPct: 77, duelSuccessPct: 54 },
      identityVerified: true,
      attendance: [att('Central Junior League final', 'Stadion GOSiR', now - 40 * day)],
      timeline: [tl('2024', 'Youth academy striker'), tl('2026', 'Turned 18 — account transition pending')],
      media: [med('Finishing compilation (U18)', 'video', now - 30 * day)],
      medical: { shared: false, records: [], conditionStatus: 'fully_fit' },
    }),
    player({
      id: 'pl-tomasz',
      name: 'Tomasz Kowalski',
      dob: '2009-08-21', // 16
      country: 'PL',
      city: 'Gdańsk',
      guardianId: 'gd-marek',
      position: 'CM',
      foot: 'right',
      heightCm: 175,
      weightKg: 64,
      stats: { appearances: 21, goals: 5, assists: 9, paceKmh: 31.0, passCompletionPct: 85, duelSuccessPct: 52 },
      identityVerified: true,
      attendance: [att('CLJ U17, round 15', 'Stadion Traugutta', now - 6 * day)],
      timeline: [tl('2023', 'Youth academy midfielder'), tl('2026', 'U17 central league debut at 16')],
      media: [med('U17 passing & pressing reel', 'video', now - 20 * day)],
      medical: { shared: false, records: [], conditionStatus: 'fully_fit' },
    }),
  ];

  // Joined-at timestamps drive the "new this week" search filter.
  players.forEach((p, i) => {
    p.createdAt = now - (((i * 11) % 40) + 2) * day;
  });
  players.find((p) => p.id === 'pl-guni').createdAt = now - 3 * day;      // new this week
  players.find((p) => p.id === 'pl-mensah').createdAt = now - 5 * day;    // new this week

  // Seeded activity streaks (self-competition only — never leaderboards).
  players.find((p) => p.id === 'pl-adeyemi').activityLog = [now - 2 * day, now - day, now - 3600_000];
  players.find((p) => p.id === 'pl-guni').activityLog = [now - 4 * day, now - 3 * day, now - 2 * day, now - day, now - 7200_000];

  // Reference archetypes for the Similar Players engine.
  const archetypes = [
    { id: 'arch-pressing-forward', label: 'Pressing forward', position: 'ST', foot: 'right', dob: '2002-01-01', heightCm: 185, weightKg: 80, stats: { appearances: 30, goals: 18, assists: 5 } },
    { id: 'arch-deep-playmaker', label: 'Deep-lying playmaker', position: 'CM', foot: 'left', dob: '2001-01-01', heightCm: 177, weightKg: 72, stats: { appearances: 30, goals: 3, assists: 10 } },
    { id: 'arch-ball-playing-cb', label: 'Ball-playing centre-back', position: 'CB', foot: 'right', dob: '2001-01-01', heightCm: 190, weightKg: 84, stats: { appearances: 30, goals: 2, assists: 1 } },
    { id: 'arch-direct-winger', label: 'Direct winger', position: 'RW', foot: 'left', dob: '2003-01-01', heightCm: 177, weightKg: 71, stats: { appearances: 30, goals: 10, assists: 11 } },
    { id: 'arch-sweeper-keeper', label: 'Sweeper keeper', position: 'GK', foot: 'right', dob: '2000-01-01', heightCm: 192, weightKg: 87, stats: { appearances: 30, goals: 0, assists: 0 } },
  ];

  // Seeded scout & coach track records; live rows are computed from the ledger.
  const reputationSeed = [
    { scoutName: 'Maria Keane', orgName: 'Eastport FC', discoveries: 14, successRatePct: 64, avgResaleMultiple: 3.1, seeded: true },
    { scoutName: 'Coach D. Ansah', orgName: 'Harbour City FC', discoveries: 9, successRatePct: 55, avgResaleMultiple: 2.2, seeded: true },
    { scoutName: 'Tomás Rivera', orgName: 'North Star Sports Agency', discoveries: 21, successRatePct: 48, avgResaleMultiple: 2.8, seeded: true },
  ];

  const plans = {
    Academy: {
      name: 'Academy',
      pricePerMonthGBP: 99,
      seats: 3,
      attributionWindowMonths: 18,
      antiCircumvention:
        'Any signing of a ScoutBox-discovered player within the attribution window, however contact was concluded, owes the discovery fee. Off-platform approaches to circumvent the ledger are a terms breach and forfeit Trusted Partner eligibility.',
    },
    Pro: {
      name: 'Pro',
      pricePerMonthGBP: 349,
      seats: 15,
      attributionWindowMonths: 24,
      antiCircumvention:
        'Any signing of a ScoutBox-discovered player within the attribution window, however contact was concluded, owes the discovery fee. Off-platform approaches to circumvent the ledger are a terms breach and forfeit Trusted Partner eligibility.',
    },
    Agency: {
      name: 'Agency',
      pricePerMonthGBP: 499,
      seats: 10,
      attributionWindowMonths: 24,
      antiCircumvention:
        'Agencies additionally warrant that no representation approach is made to any player who has not accepted a contact request, and never to a minor under any circumstances.',
    },
  };

  return {
    orgs,
    guardians,
    players,
    archetypes,
    reputationSeed,
    plans,
    users: [],       // org scout users, created at org login (with verified role)
    requests: [],    // contact/trial requests (minors: routed to guardian)
    trials: [],      // accepted trials awaiting/holding reports
    ledger: [],      // append-only Discovery Ledger
    reports: [],     // report-user/scout/club submissions (status → resolved)
    blocks: [],      // {playerId, orgId, by, reason} — org loses all access
    moderationLog: [],
    sessions: [],
    outbox: [],
    pushLog: [],
    pushTokens: [],
    invoices: [],
    emailChallenges: [],
    channels: [],       // moderated message threads, opened on acceptance
    notifications: [],  // in-app notification feed per audience
    mediaBlobs: {},     // mediaId → { dataUrl } for uploaded video (prototype store)
  };
}

function player(p) {
  return {
    badges: [],
    attendance: [],
    timeline: [],
    media: [],
    trialReports: [],
    medical: { shared: false, records: [], conditionStatus: 'unknown' },
    identityVerified: false,
    academyPlus: false,
    guardianId: null,
    squadNumber: null,
    contractUntil: null,
    marketValueRange: null,
    agentName: null,
    availability: 'not_seeking',
    contractStatus: 'unknown',
    drills: [],
    drillResults: [],  // at-home combine: {drillId, value, verified, ts}
    activityLog: [],   // timestamps of football activity (streaks/goals)
    createdAt: null,
    password: null, // optional; when set, login requires it
    ...p,
  };
}

function att(fixture, venue, ts) {
  return {
    id: `att-${Math.abs(hash(fixture + ts))}`,
    fixture,
    venue,
    date: new Date(ts).toISOString().slice(0, 10),
    gps: { lat: 51.5 + (hash(venue) % 100) / 1000, lng: -0.12 + (hash(fixture) % 100) / 1000 },
    deviceConfirmed: true,
    verified: true,
  };
}

function tl(year, event) {
  return { year, event };
}

function med(title, kind, ts) {
  return { id: `media-${Math.abs(hash(title))}`, title, kind, uploadedAt: new Date(ts).toISOString() };
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0;
  return h;
}
