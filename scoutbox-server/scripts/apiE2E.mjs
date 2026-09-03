// Live API end-to-end. Run against a FRESHLY SEEDED server (delete data/
// first): `node server.mjs & node scripts/apiE2E.mjs`. Exercises the full
// M6+M7 surface: token auth, safeguarding gates, trials, exports, billing,
// verification, moderation escalation and persistence.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.API_URL || 'http://localhost:4000';
const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const ok = (cond, name) => {
  if (!cond) { console.error(`✗ ${name}`); process.exit(1); }
  passed++; console.log(`✓ ${name}`);
};
const j = async (pathname, opts = {}, headers = {}) => {
  const res = await fetch(`${API}${pathname}`, { ...opts, headers: { 'content-type': 'application/json', ...headers } });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
};
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const admin = { 'x-admin-key': process.env.ADMIN_KEY || 'scoutbox-admin' };

// ---- 0. auth fundamentals
let r = await j('/player/me', {}, { 'x-player-id': 'pl-adeyemi' });
ok(r.status === 401, 'legacy trusted-id headers are refused');
r = await j('/auth/player/signup', { method: 'POST', body: JSON.stringify({ name: 'No Pw', dob: '2000-01-01', country: 'GB' }) });
ok(r.status === 400 && r.body.error === 'PASSWORD_REQUIRED', 'signup without a password is refused');
r = await j('/auth/player/signup', { method: 'POST', body: JSON.stringify({ name: 'Locked Player', dob: '2000-01-01', country: 'GB', password: 'longenough1', position: 'CM' }) });
ok(r.status === 201 && r.body.token && !('password' in (r.body.player ?? {})), 'signup mints a session token and never echoes the hash');
const lockedId = r.body.playerId;
r = await j('/auth/player/login', { method: 'POST', body: JSON.stringify({ playerId: lockedId, password: 'wrong-password' }) });
ok(r.status === 401, 'wrong password is refused');
r = await j('/auth/player/login', { method: 'POST', body: JSON.stringify({ playerId: lockedId, password: 'longenough1' }) });
ok(r.status === 200 && r.body.token, 'correct password logs in');
const lockedToken = r.body.token;
r = await j('/player/me', {}, bearer(lockedToken));
ok(r.status === 200 && r.body.name === 'Locked Player', 'bearer token resolves the caller');
r = await j('/auth/logout', { method: 'POST' }, bearer(lockedToken));
ok(r.status === 200, 'logout succeeds');
r = await j('/player/me', {}, bearer(lockedToken));
ok(r.status === 401, 'logged-out token is dead');

const login = async (playerId, password) =>
  (await j('/auth/player/login', { method: 'POST', body: JSON.stringify({ playerId, password }) })).body.token;
const KOLA = await login('pl-adeyemi');
const GUNI = await login('pl-guni');
const SVEN = await login('pl-svensson');
const IMANI = await login('pl-imani');
const AMARA = (await j('/auth/guardian/login', { method: 'POST', body: JSON.stringify({ guardianId: 'gd-amara' }) })).body.token;
const orgLogin = await j('/auth/org/login', { method: 'POST', body: JSON.stringify({ orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' }) });
const EASTPORT = orgLogin.body.token;
ok(!!(KOLA && GUNI && AMARA && EASTPORT), 'seed identities log in (passwordless demo seeds)');

// ---- 1. guardian signup: email verification is a hard gate
r = await j('/auth/guardian/signup', { method: 'POST', body: JSON.stringify({ name: 'Nadia Test', email: 'nadia@testfamily.co.uk', password: 'longenough1' }) });
ok(r.status === 201 && r.body.emailVerificationSent, 'guardian signup sends the verification email');
const nadiaId = r.body.guardianId;
const nadiaToken = r.body.token;
await j('/guardian/verify-id', { method: 'POST', body: JSON.stringify({ documentType: 'passport', documentRef: 'X1234567' }) }, bearer(nadiaToken));
await j('/guardian/disclaimer', { method: 'POST', body: JSON.stringify({ accepted: true }) }, bearer(nadiaToken));
r = await j('/guardian/children', { method: 'POST', body: JSON.stringify({ name: 'Test Kid', dob: '2013-01-01', country: 'GB' }) }, bearer(nadiaToken));
ok(r.status === 403 && r.body.error === 'EMAIL_UNVERIFIED', 'unverified email blocks child onboarding even after IDV + disclaimer');
const outbox = await j('/admin/outbox', {}, admin);
const mail = outbox.body.find((m) => m.to === 'nadia@testfamily.co.uk');
const emailCode = /code is ([A-Z0-9]{6})/.exec(mail?.text ?? '')?.[1];
ok(!!emailCode, 'verification code is in the dev outbox');
r = await j('/auth/guardian/verify-email', { method: 'POST', body: JSON.stringify({ guardianId: nadiaId, code: emailCode }) });
ok(r.status === 200 && r.body.emailVerified, 'email code verifies the guardian');
r = await j('/guardian/children', { method: 'POST', body: JSON.stringify({ name: 'Test Kid', dob: '2013-01-01', country: 'GB' }) }, bearer(nadiaToken));
ok(r.status === 201, 'child onboarding opens after all three gates');

// ---- 2. pairing (single-use, random codes)
r = await j('/guardian/children/pl-guni/pairing-code', { method: 'POST' }, bearer(AMARA));
ok(r.status === 201 && /^[A-Z0-9]{6}$/.test(r.body.code), 'guardian mints a random 6-char pairing code');
const code = r.body.code;
r = await j('/auth/player/pair', { method: 'POST', body: JSON.stringify({ code: 'WRONG1' }) });
ok(r.status === 404, 'wrong pairing code is refused');
r = await j('/auth/player/pair', { method: 'POST', body: JSON.stringify({ code }) });
ok(r.status === 200 && r.body.playerId === 'pl-guni' && r.body.token, 'pairing exchanges the code for a child session token');
r = await j('/auth/player/pair', { method: 'POST', body: JSON.stringify({ code }) });
ok(r.status === 404, 'pairing code is single-use');

// ---- 3. trial with alt slots → chosen slot → ICS
r = await j('/org/players/pl-adeyemi/request', {
  method: 'POST',
  body: JSON.stringify({ type: 'trial', message: 'Assessment day — pick a slot.', proposedDate: '2026-09-05', altSlots: ['2026-09-12', '2026-09-19'], venue: 'Eastport Dome', notes: 'Bring boots.' }),
}, bearer(EASTPORT));
ok(r.status === 201, 'org sends trial request with alt slots');
const reqId = r.body.requestId;
let inbox = await j('/player/inbox', {}, bearer(KOLA));
ok(inbox.body.find((x) => x.id === reqId)?.trialDetails?.altSlots?.length === 2, 'player sees proposed + alt slots');
r = await j(`/player/requests/${reqId}/respond`, { method: 'POST', body: JSON.stringify({ accept: true, chosenSlot: '2026-09-12' }) }, bearer(KOLA));
ok(r.status === 200, 'player accepts choosing an alt slot');
let trials = await j('/org/trials', {}, bearer(EASTPORT));
const trial = trials.body.find((t) => t.requestId === reqId);
ok(trial?.proposedDate === '2026-09-12', 'trial is booked on the chosen alt slot');
const ics = await fetch(`${API}/org/trials/${trial.id}/ics`, { headers: bearer(EASTPORT) });
const icsText = await ics.text();
ok(ics.status === 200 && icsText.includes('BEGIN:VCALENDAR') && icsText.includes('20260912'), 'trial exports as ICS with the chosen date');

// ---- 4. season history, prefs
r = await j('/player/stats', { method: 'POST', body: JSON.stringify({ appearances: 20, goals: 9, assists: 3, season: '2022/23' }) }, bearer(KOLA));
ok(r.status === 200 && r.body.seasonHistory.some((s) => s.season === '2022/23' && s.goals === 9), 'past-season stats file into season history');
r = await j('/player/prefs', { method: 'POST', body: JSON.stringify({ quietStart: '22:00', quietEnd: '07:00' }) }, bearer(KOLA));
ok(r.status === 200 && r.body.prefs.quietStart === '22:00', 'player sets quiet hours');

// ---- 5. saved search + alert
await j('/org/searches', { method: 'POST', body: JSON.stringify({ name: 'Young strikers GB', filters: { position: 'ST', country: 'GB' } }) }, bearer(EASTPORT));
r = await j('/auth/player/signup', { method: 'POST', body: JSON.stringify({ name: 'Alerted Striker', dob: '2005-01-01', country: 'GB', position: 'ST', password: 'longenough1' }) });
const newPlayerId = r.body.playerId;
const newPlayerToken = r.body.token;
let notifs = await j('/org/notifications', {}, bearer(EASTPORT));
ok(notifs.body.some((n) => n.type === 'saved_search' && /Young strikers GB/.test(n.text)), 'saved-search alert fires for the new signup');

// ---- 6. mandatory report with feedback, then minor trial via guardian slot choice
r = await j(`/org/trials/${trial.id}/report`, {
  method: 'POST',
  body: JSON.stringify({ acceleration: 8, sprintSpeedKmh: 33.4, distanceKm: 9.1, passCompletionPct: 81, duelSuccessPct: 63, coachRating: 8, strengthNote: 'Ruthless in the box.', focusNote: 'Weak-side pressing.' }),
}, bearer(EASTPORT));
ok(r.status === 201 || r.status === 200, 'org files the mandatory trial report with feedback notes');
let me = await j('/player/me', {}, bearer(KOLA));
ok(/Ruthless/.test(me.body.trialReports.find((x) => x.orgName === 'Eastport FC')?.strengthNote ?? ''), 'feedback lands on the player profile');

r = await j('/org/players/pl-guni/request', {
  method: 'POST',
  body: JSON.stringify({ type: 'trial', message: 'U15 assessment for Guni.', proposedDate: '2026-09-06', altSlots: ['2026-09-13'], venue: 'Eastport Dome', notes: 'U15 day.' }),
}, bearer(EASTPORT));
ok(r.status === 201 && r.body.routedTo === 'guardian', 'minor trial request routes to guardian');
const gReqId = r.body.requestId;
r = await j(`/guardian/requests/${gReqId}/respond`, { method: 'POST', body: JSON.stringify({ accept: true, chosenSlot: '2026-09-13' }) }, bearer(AMARA));
ok(r.status === 200, 'guardian accepts choosing the alt slot');
trials = await j('/org/trials', {}, bearer(EASTPORT));
ok(trials.body.some((t) => t.requestId === gReqId && t.proposedDate === '2026-09-13'), 'guardian-chosen slot books the trial');

// ---- 7. moderation v2: grooming language blocks AND escalates
const guniChannel = (await j('/guardian/channels', {}, bearer(AMARA))).body.find((c) => c.requestId === gReqId);
r = await j(`/org/channels/${guniChannel.id}/messages`, { method: 'POST', body: JSON.stringify({ text: "Great session. Don't tell your parents but we should keep this between us." }) }, bearer(EASTPORT));
ok(r.status === 400 && r.body.error === 'MODERATION_BLOCKED', 'grooming-pattern message is blocked');
let adminReports = await j('/admin/reports', {}, admin);
ok(adminReports.body.some((x) => x.by === 'system' && x.urgent && /grooming/.test(x.reason)), 'grooming hit auto-escalates as an urgent report');
ok(adminReports.body[0].urgent === true, 'admin triage puts urgent reports first');

// ---- 8. funnel + signing → invoice
r = await j('/org/players/pl-svensson/request', { method: 'POST', body: JSON.stringify({ type: 'contact', message: 'First-team conversation.' }) }, bearer(EASTPORT));
await j(`/player/requests/${r.body.requestId}/respond`, { method: 'POST', body: JSON.stringify({ accept: true }) }, bearer(SVEN));
r = await j('/org/players/pl-svensson/signing', { method: 'POST', body: JSON.stringify({ note: 'Signed after trial run.' }) }, bearer(EASTPORT));
ok(r.status === 201 && r.body.signing.insideAttributionWindow, 'signing recorded inside attribution window');
let invoices = await j('/org/invoices', {}, bearer(EASTPORT));
ok(invoices.body.some((i) => i.signingId === r.body.signing.id && i.amount > 0), 'success-fee invoice issued through the billing adapter');
let funnel = await j('/org/funnel', {}, bearer(EASTPORT));
const stage = (k) => funnel.body.stages.find((s) => s.key === k)?.count ?? -1;
ok(stage('requests') >= 3 && stage('trials') >= 2 && stage('signings') >= 1, 'funnel computes real stage counts from the ledger');

// ---- 9. club email-domain verification
r = await j('/org/verification/email', { method: 'POST', body: JSON.stringify({ email: 'scout@gmail.com' }) }, bearer(EASTPORT));
ok(r.status === 422, 'free-mail domains are refused for club verification');
r = await j('/org/verification/email', { method: 'POST', body: JSON.stringify({ email: 'recruitment@eastportfc.co.uk' }) }, bearer(EASTPORT));
ok(r.status === 201, 'company-domain challenge sent');
const vMail = (await j('/admin/outbox', {}, admin)).body.find((m) => m.to === 'recruitment@eastportfc.co.uk');
const vCode = /code is ([A-Z0-9]{6})/.exec(vMail?.text ?? '')?.[1];
r = await j('/org/verification/email/confirm', { method: 'POST', body: JSON.stringify({ code: vCode }) }, bearer(EASTPORT));
ok(r.status === 200 && r.body.emailDomain === 'eastportfc.co.uk', 'code from the mailbox confirms domain control');

// ---- 10. exports, deletion rules, aging-up
r = await j('/player/export', {}, bearer(KOLA));
ok(r.body.profile?.id === 'pl-adeyemi' && r.body.profile.password === undefined, 'player export bundles data, never the hash');
r = await j('/guardian/export', {}, bearer(AMARA));
ok(r.body.guardian?.id === 'gd-amara' && r.body.guardian.password === undefined, 'guardian export is sanitized');
r = await j('/player/account', { method: 'DELETE' }, bearer(GUNI));
ok(r.status === 403 && r.body.error === 'GUARDIAN_MANAGED', 'minor cannot self-delete');
r = await j('/player/account', { method: 'DELETE' }, bearer(newPlayerToken));
ok(r.status === 200, 'adult deletes own account');
me = await j('/player/me', {}, bearer(IMANI));
ok(me.body.agingUp?.eligible === true, 'imani (18, guardian-linked) is aging-up eligible');
r = await j('/player/aging-up/complete', { method: 'POST' }, bearer(IMANI));
ok(r.status === 200, 'aging-up handover completes');

// ---- 11. admin resolve reaches the reporter; push log records delivery
await j('/player/report', { method: 'POST', body: JSON.stringify({ targetKind: 'club', targetOrgId: 'org-harbour', reason: 'Asked to move to WhatsApp', urgent: true }) }, bearer(KOLA));
const rep = (await j('/admin/reports', {}, admin)).body.find((x) => x.status === 'pending_review' && x.by === 'player');
r = await j(`/admin/reports/${rep.id}/resolve`, { method: 'POST', body: JSON.stringify({ outcome: 'Warning issued to the club.', action: 'warning' }) }, admin);
ok(r.status === 200, 'admin resolves the report');
const myReports = await j('/player/reports', {}, bearer(KOLA));
ok(myReports.body.some((x) => x.id === rep.id && /Warning issued/.test(x.outcome ?? '')), 'resolution reaches the reporter');
const pushLog = await j('/admin/push-log', {}, admin);
ok(pushLog.body.length > 0, 'push adapter records deliveries (dev transport)');

// ---- 12. platform separation: ScoutBox Grassroots
r = await j('/auth/org/login', { method: 'POST', body: JSON.stringify({ orgId: 'org-eastport', scoutName: 'Maria Keane', platform: 'grassroots' }) });
ok(r.status === 403 && r.body.error === 'PLATFORM_MISMATCH', 'pro club cannot log into ScoutBox Grassroots');
r = await j('/auth/org/login', { method: 'POST', body: JSON.stringify({ orgId: 'org-hackneymarsh', scoutName: 'Dee Mensah', role: 'Manager' }) });
ok(r.status === 403 && r.body.error === 'GRASSROOTS_PLATFORM_ONLY', 'grassroots club cannot log into the main platform');
r = await j('/auth/org/login', { method: 'POST', body: JSON.stringify({ orgId: 'org-hackneymarsh', scoutName: 'Dee Mensah', role: 'Manager', platform: 'grassroots' }) });
ok(r.status === 200 && r.body.token, 'grassroots club logs in on its own platform');
const HACKNEY = r.body.token;
const MOSS = (await j('/auth/org/login', { method: 'POST', body: JSON.stringify({ orgId: 'org-mossside', scoutName: 'Pat Doyle', platform: 'grassroots' }) })).body.token;

let orgList = await j('/orgs?platform=grassroots');
ok(orgList.body.length >= 2 && orgList.body.every((o) => o.level === 'grassroots'), 'grassroots login screen lists only grassroots clubs');
orgList = await j('/orgs?platform=main');
ok(orgList.body.every((o) => o.level !== 'grassroots'), 'main login screen never lists grassroots clubs');

// Hackney (London, verified): sees local minor Guni, not Manchester's Kola,
// and never a pro-level player.
let gsearch = await j('/org/players', {}, bearer(HACKNEY));
const names = gsearch.body.map((p) => p.name);
ok(names.includes('Guni Adebayo'), 'verified grassroots club sees a LOCAL minor (safeguarding bar identical)');
ok(!names.includes('Kola Adeyemi'), 'players beyond 50km are invisible to grassroots clubs');
ok(!names.includes('Elias Svensson'), 'pro-level players never appear on Grassroots');
ok(gsearch.body.every((p) => typeof p.distanceKm === 'number' && p.distanceKm <= 50), 'grassroots views carry distance, all within radius');
ok(gsearch.body.every((p) => !('academyPlus' in p) && !('marketValueRange' in p) && !('agentName' in p)), 'pro-market surface (Academy+, value, agent) stripped on Grassroots');
r = await j('/org/players/pl-adeyemi', {}, bearer(HACKNEY));
ok(r.status === 403 || r.status === 404, 'direct profile fetch beyond the radius refused');

// Moss Side (Manchester, unverified): adults-only, local-only.
gsearch = await j('/org/players', {}, bearer(MOSS));
ok(gsearch.body.some((p) => p.name === 'Kola Adeyemi'), 'Manchester grassroots club sees Manchester amateur');
ok(!gsearch.body.some((p) => p.guardianManaged), 'unverified grassroots club sees no minors — same rule as everywhere');

// Grassroots signing sets the player semi-pro (still on the platform).
await j('/org/players/pl-adeyemi/request', { method: 'POST', body: JSON.stringify({ type: 'contact', message: 'First-team spot this season.' }) }, bearer(MOSS));
r = await j('/org/players/pl-adeyemi/signing', { method: 'POST' }, bearer(MOSS));
ok(r.status === 201, 'grassroots club records a signing');
gsearch = await j('/org/players', {}, bearer(MOSS));
ok(gsearch.body.find((p) => p.id === 'pl-adeyemi')?.level === 'semi_pro', 'grassroots signing makes the player semi-pro, still visible locally');

// A pro signing removes the player from Grassroots entirely (Svensson,
// signed by Eastport in section 8, is now level pro).
const svView = await j('/org/players/pl-svensson', {}, bearer(EASTPORT));
ok(svView.body.level === 'pro', 'academy/pro signing marks the player pro');

// Registration requires federation details + a ground location.
r = await j('/auth/org/register-grassroots', { method: 'POST', body: JSON.stringify({ name: 'No Fed FC', scoutName: 'A' }) });
ok(r.status === 400 && r.body.error === 'FEDERATION_REQUIRED', 'registration without federation record refused');
r = await j('/auth/org/register-grassroots', {
  method: 'POST',
  body: JSON.stringify({ name: 'Leyton Sunday Stars', country: 'GB', city: 'London', lat: 51.56, lng: -0.005, federation: 'The FA (England)', registrationId: 'FA-GR-3344', scoutName: 'Sam Cole', role: 'Manager' }),
});
ok(r.status === 201 && r.body.token && r.body.org.level === 'grassroots' && r.body.org.verified === false, 'grassroots registration opens unverified (adults-only) with a token');
gsearch = await j('/org/players', {}, bearer(r.body.token));
ok(gsearch.body.every((p) => !p.guardianManaged && p.distanceKm <= 50), 'freshly registered club: local adults only until verification');

// ---- 13. the Grassroots player journey (M9)
// Kola became semi-pro via the Moss Side signing above — the level-up moment
// should have fired: badge, pathway, timeline.
me = await j('/player/me', {}, bearer(KOLA));
ok(me.body.pathway?.level === 'semi_pro' && me.body.pathway.steps.find((s) => s.key === 'semi_pro').reached, 'pathway shows the level-up');
ok(me.body.badges.includes('First Club'), 'level-up awarded the First Club badge');
ok(me.body.timeline.some((t) => /Levelled up: amateur → semi-pro/.test(t.event)), 'level-up recorded on the timeline');

// Training programme: suggested by position, weekly progress, feeds streaks.
r = await j('/player/programme', {}, bearer(KOLA));
ok(r.status === 200 && r.body.suggested === 'attack', 'programme suggests the attacking track for a striker');
r = await j('/player/programme', { method: 'POST', body: JSON.stringify({ track: 'attack' }) }, bearer(KOLA));
ok(r.status === 201 && r.body.current.doneThisWeek === 0, 'programme selected');
r = await j('/player/programme/sessions/atk-sprint/complete', { method: 'POST' }, bearer(KOLA));
ok(r.body.current.doneThisWeek === 1 && r.body.current.sessions.find((x) => x.id === 'atk-sprint').done, 'session completion tracked weekly');
r = await j('/player/programme', {}, bearer(SVEN));
ok(r.status === 403 && r.body.error === 'GRASSROOTS_ONLY', 'pro players have no grassroots programme');

// Benchmarks: cohort percentiles, explicitly not a leaderboard.
r = await j('/player/benchmarks', {}, bearer(KOLA));
ok(r.status === 200 && /not competition/.test(r.body.note) && Array.isArray(r.body.stats), 'benchmarks return cohort percentiles, framed as context');

// Opportunity radar: Moss Side (Manchester) is in Kola's radius.
await j('/org/looking-for', { method: 'POST', body: JSON.stringify({ positions: ['ST', 'CDM'] }) }, bearer(MOSS));
r = await j('/org/open-trials', {
  method: 'POST',
  body: JSON.stringify({ title: 'Open training session', date: '2099-05-01', venue: 'Moss Side Rec', ageGroup: 'open', positions: ['ST'] }),
}, bearer(MOSS));
ok(r.status === 201, 'grassroots club posts an open trial day');
const mossTrialId = r.body.openTrial.id;
r = await j('/org/open-trials', { method: 'POST', body: JSON.stringify({ title: 'x', date: '2099-05-01', venue: 'y' }) }, bearer(EASTPORT));
ok(r.status === 403 && r.body.error === 'GRASSROOTS_ORGS_ONLY', 'open days are grassroots-only');
r = await j('/player/opportunities', {}, bearer(KOLA));
ok(r.body.clubs.some((c) => c.name === 'Moss Side Athletic' && c.lookingFor.includes('ST')), 'radar shows the local club looking for his position');
ok(r.body.lookingForYou >= 1, 'radar counts clubs looking for the player');
r = await j(`/player/open-trials/${mossTrialId}/register`, { method: 'POST' }, bearer(KOLA));
ok(r.status === 201, 'adult registers for a local open day');
r = await j(`/player/open-trials/${mossTrialId}/register`, { method: 'POST' }, bearer(KOLA));
ok(r.status === 409, 'double registration refused');

// First Team Seekers: surfaced first to grassroots clubs, never purchasable.
await j('/player/first-team-seeker', { method: 'POST', body: JSON.stringify({ enabled: true }) }, bearer(KOLA));
gsearch = await j('/org/players', {}, bearer(MOSS));
ok(gsearch.body.find((p) => p.id === 'pl-adeyemi')?.firstTeamSeeker === true, 'seeker flag visible to grassroots clubs');

// Coach vouches: email-code verified, moderated, coach email never exposed.
r = await j('/player/vouches/request', { method: 'POST', body: JSON.stringify({ coachName: 'Ade Falana', coachEmail: 'ade@sundayleague.org.uk', role: 'Manager' }) }, bearer(KOLA));
ok(r.status === 201, 'vouch request sent to the coach');
const vMailBox = await j('/admin/outbox', {}, admin);
const vouchMail = vMailBox.body.find((m) => m.to === 'ade@sundayleague.org.uk');
const vouchCode = /reference code is ([A-Z0-9]{8})/.exec(vouchMail?.text ?? '')?.[1];
ok(!!vouchCode, 'vouch code delivered via the mailer');
r = await j('/vouch/submit', { method: 'POST', body: JSON.stringify({ code: vouchCode, text: "Don't tell your parents but call me on 07911 123456" }) });
ok(r.status === 400 && r.body.error === 'MODERATION_BLOCKED', 'vouch text passes through the same moderation screen');
r = await j('/vouch/submit', { method: 'POST', body: JSON.stringify({ code: vouchCode, text: 'Two seasons with me — never missed a session, leads the line brilliantly.', seasons: '2024–2026' }) });
ok(r.status === 201, 'clean vouch publishes');
gsearch = await j(`/org/players/pl-adeyemi`, {}, bearer(MOSS));
ok(gsearch.body.vouches?.some((v) => /leads the line/.test(v.text)) && !('coachEmail' in (gsearch.body.vouches?.[0] ?? {})), 'published vouch visible to clubs, coach email never exposed');

// Guardian route: open days for a child list only clubs allowed to see them.
r = await j('/org/open-trials', {
  method: 'POST',
  body: JSON.stringify({ title: 'U15 open morning', date: '2099-06-01', venue: 'Hackney Marshes pitch 4', ageGroup: 'u16' }),
}, bearer(HACKNEY));
const hackneyTrialId = r.body.openTrial.id;
r = await j('/guardian/children/pl-guni/open-trials', {}, bearer(AMARA));
ok(r.body.openTrials.some((t) => t.id === hackneyTrialId) && !r.body.openTrials.some((t) => t.id === mossTrialId), 'guardian sees local verified open days only');
r = await j(`/guardian/open-trials/${mossTrialId}/register`, { method: 'POST', body: JSON.stringify({ childId: 'pl-guni' }) }, bearer(AMARA));
ok(r.status === 403, 'minor registration to a club that may not see them is refused');
r = await j(`/guardian/open-trials/${hackneyTrialId}/register`, { method: 'POST', body: JSON.stringify({ childId: 'pl-guni' }) }, bearer(AMARA));
ok(r.status === 201, 'guardian registers the child for a verified local open day');
r = await j('/org/open-trials', {}, bearer(HACKNEY));
ok(r.body.find((t) => t.id === hackneyTrialId)?.registrations.some((x) => x.playerName === 'Guni Adebayo' && x.byGuardian), 'club sees the guardian-made registration');

// Season wrap.
r = await j('/player/season-wrap', {}, bearer(KOLA));
ok(r.status === 200 && r.body.badges.includes('First Club') && /ledger/.test(r.body.note), 'season wrap assembles the verified year');

// ---- 14. storage + SQLite persistence on disk
let stored = false;
for (let i = 0; i < 20 && !stored; i++) {
  stored = fs.existsSync(path.join(SERVER_DIR, 'data', 'scoutbox.db')) || fs.existsSync(path.join(SERVER_DIR, 'data', 'db.json'));
  if (!stored) await new Promise((res) => setTimeout(res, 500));
}
ok(stored, 'snapshot persisted (SQLite, or JSON fallback on old Node)');
ok(fs.existsSync(path.join(SERVER_DIR, 'data', 'media')), 'media blobs live on object storage (disk), outside the database');

console.log(`\n${passed} API checks passed`);
