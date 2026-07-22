// Self-contained demo client — used when EXPO_PUBLIC_API_URL is not set.
// Simulates the server's behaviour (age gate, inbox flow, trust score) so the
// app demos without any backend. The real rules are enforced by
// scoutbox-server; this is a faithful imitation for demo mode only.

import type { PlayerClient, SignupInput, Me, AttendanceInput, DemoIdentity } from './types';
import { ClientError } from './types';
import type { Availability, ContractStatus, InboxRequest, PlayerProfile } from '../domain/types';
import { adultAgeFor, ageOn } from '../domain/safeguarding';
import { computeTrustScore, trustBreakdown } from '../domain/trustScore';

const players = new Map<string, PlayerProfile>();
const inboxes = new Map<string, InboxRequest[]>();
const listeners = new Set<() => void>();
let idc = 100;
const nid = (p: string) => `${p}-${++idc}`;
const emit = () => listeners.forEach((l) => l());
const delay = <T,>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(v), 100));

function seedDemoPlayer(): PlayerProfile {
  return {
    id: 'demo-adeyemi',
    name: 'Kola Adeyemi',
    dob: '2004-03-14',
    country: 'GB',
    city: 'Manchester',
    position: 'ST',
    foot: 'right',
    heightCm: 184,
    weightKg: 79,
    stats: { appearances: 31, goals: 22, assists: 6, paceKmh: 34.1, passCompletionPct: 78, duelSuccessPct: 61 },
    academyPlus: true,
    badges: ['Finisher', 'Pressing Forward', 'Fresh Start'],
    availability: 'available_now',
    contractStatus: 'expiring_summer',
    identityVerified: true,
    attendance: [
      { id: 'att-1', fixture: 'Sunday League Cup Final', venue: 'Hough End Playing Fields', date: '2026-07-02', gps: { lat: 53.43, lng: -2.26 }, verified: true },
      { id: 'att-2', fixture: 'County Trial Day', venue: 'Platt Lane Complex', date: '2026-05-23', gps: { lat: 53.45, lng: -2.23 }, verified: true },
    ],
    timeline: [
      { year: '2019', event: 'Joined local academy U15s' },
      { year: '2022', event: 'Released at 18 — continued in county football' },
      { year: '2025', event: 'Top scorer, county premier division' },
    ],
    media: [
      { id: 'm1', title: 'Match highlights vs Riverside', kind: 'video', uploadedAt: new Date(Date.now() - 25 * 86400000).toISOString() },
      { id: 'm2', title: 'Sprint & finishing session', kind: 'video', uploadedAt: new Date(Date.now() - 80 * 86400000).toISOString() },
    ],
    trialReports: [],
    medical: {
      shared: false,
      conditionStatus: 'fully_fit',
      records: [
        { id: 'md-1', type: 'injury', title: 'Hamstring strain (grade 1)', date: '2025-11-02', layoffWeeks: 3, cleared: true },
        { id: 'md-2', type: 'clearance', title: 'Pre-season cardiac screen — clear', date: '2026-01-15', layoffWeeks: null, cleared: true },
      ],
    },
  };
}

function ensureSeed() {
  if (!players.has('demo-adeyemi')) {
    players.set('demo-adeyemi', seedDemoPlayer());
    inboxes.set('demo-adeyemi', [
      {
        id: nid('req'),
        type: 'contact',
        orgName: 'Harbour City FC',
        orgType: 'club',
        trustedPartner: false,
        scoutName: 'Coach D. Ansah',
        message: 'Watched your cup final highlights — strong movement. Our first-team coach would like a conversation.',
        status: 'pending',
        createdAt: Date.now() - 3600_000,
        contactChannel: null,
      },
    ]);
    // Demo liveliness: a trial request lands shortly after login.
    setTimeout(() => {
      const inbox = inboxes.get('demo-adeyemi');
      if (inbox && !inbox.some((r) => r.type === 'trial')) {
        inbox.unshift({
          id: nid('req'),
          type: 'trial',
          orgName: 'Eastport FC',
          orgType: 'club',
          trustedPartner: true,
          scoutName: 'Maria Keane',
          message: 'We run assessment trials monthly. Full performance report guaranteed — it goes on your profile.',
          status: 'pending',
          createdAt: Date.now(),
          contactChannel: null,
        });
        emit();
      }
    }, 8000);
  }
}

function getPlayer(playerId: string): PlayerProfile {
  ensureSeed();
  const p = players.get(playerId);
  if (!p) throw new ClientError('PLAYER_NOT_FOUND', 'No such player');
  return p;
}

export const mockClient: PlayerClient = {
  mode: 'demo',

  listDemoIdentities: async (): Promise<DemoIdentity[]> => {
    ensureSeed();
    return [{ id: 'demo-adeyemi', name: 'Kola Adeyemi', position: 'ST' }];
  },

  signup: (input: SignupInput) => {
    // Mirrors the server's 403 ADULTS_ONLY.
    const required = adultAgeFor(input.country);
    if (ageOn(input.dob) < required) {
      throw new ClientError('ADULTS_ONLY', `ScoutBox is launching adults-only. You must be ${required}+ in your country to create a profile.`);
    }
    const p: PlayerProfile = {
      id: nid('demo'),
      name: input.name,
      dob: input.dob,
      country: input.country,
      city: input.city ?? '',
      position: input.position ?? null,
      foot: input.foot ?? null,
      heightCm: input.heightCm ?? null,
      weightKg: input.weightKg ?? null,
      stats: null,
      academyPlus: false,
      badges: [],
      availability: 'not_seeking',
      contractStatus: 'unknown',
      identityVerified: false,
      attendance: [],
      timeline: [],
      media: [],
      trialReports: [],
      medical: { shared: false, records: [], conditionStatus: 'unknown' },
    };
    players.set(p.id, p);
    inboxes.set(p.id, []);
    return delay({ playerId: p.id });
  },

  getMe: (playerId) => {
    const p = getPlayer(playerId);
    return delay<Me>({ ...p, age: ageOn(p.dob), trustScore: computeTrustScore(p), trust: trustBreakdown(p) });
  },

  getInbox: (playerId) => {
    getPlayer(playerId);
    return delay((inboxes.get(playerId) ?? []).slice());
  },

  respond: (playerId, requestId, accept) => {
    getPlayer(playerId);
    const req = (inboxes.get(playerId) ?? []).find((r) => r.id === requestId);
    if (!req) throw new ClientError('REQUEST_NOT_FOUND', 'No such request');
    if (req.status !== 'pending') throw new ClientError('ALREADY_RESPONDED', 'Already responded');
    req.status = accept ? 'accepted' : 'declined';
    if (accept) req.contactChannel = nid('chan');
    emit();
    return delay(undefined);
  },

  setAcademyPlus: (playerId, enabled) => {
    const p = getPlayer(playerId);
    p.academyPlus = enabled;
    if (enabled && !p.badges.includes('Fresh Start')) p.badges.push('Fresh Start');
    if (!enabled) p.badges = p.badges.filter((b) => b !== 'Fresh Start');
    emit();
    return delay(undefined);
  },

  addMedia: (playerId, title) => {
    const p = getPlayer(playerId);
    p.media.push({ id: nid('m'), title, kind: 'video', uploadedAt: new Date().toISOString() });
    emit();
    return delay(undefined);
  },

  setMedicalShared: (playerId, shared) => {
    getPlayer(playerId).medical.shared = shared;
    emit();
    return delay(undefined);
  },

  setAvailability: (playerId, availability?: Availability, contractStatus?: ContractStatus) => {
    const p = getPlayer(playerId);
    if (availability) p.availability = availability;
    if (contractStatus) p.contractStatus = contractStatus;
    emit();
    return delay(undefined);
  },

  addAttendance: (playerId, input: AttendanceInput) => {
    // Mirrors the server's ATTENDANCE_UNVERIFIABLE guard.
    if (!input.fixture || !input.venue || !input.date || !input.gps || !input.deviceId) {
      throw new ClientError('ATTENDANCE_UNVERIFIABLE', 'Verified attendance needs fixture, venue, date, GPS and device data.');
    }
    const p = getPlayer(playerId);
    p.attendance.push({ id: nid('att'), fixture: input.fixture, venue: input.venue, date: input.date, gps: input.gps, verified: true });
    emit();
    return delay(undefined);
  },

  addTimeline: (playerId, year, event) => {
    getPlayer(playerId).timeline.push({ year, event });
    emit();
    return delay(undefined);
  },

  onChange: (cb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};
