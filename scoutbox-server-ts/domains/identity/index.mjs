// Identity: sessions and sign-in, the player, guardian and organisation accounts, children, and a player's data rights.
import { needs, strictContext } from '../platform/deps.mjs';
import { registerChildren } from './children.mjs';
import { createPlayerErasure, registerDataRights } from './dataRights.mjs';
import { registerGuardianAccount, registerGuardianIdReview } from './guardians.mjs';
import { createMfaGuards } from './mfaGuards.mjs';
import { createOrgSession, createOrgViews, registerClubDirectory, registerOrgAccount } from './orgs.mjs';
import { createPlayerSession, registerPlayerAccount } from './players.mjs';
import { createLoginBudget, createSessionAccess, devLoginRefused, registerSessionRoutes } from './sessions.mjs';

/** Session lookup and the sign-in budget. No routes: the HTTP envelope installs the session reads before any. */
export function createSessions(deps) {
  const { sessions, rateLimit } = needs('createSessions', deps, ['sessions', 'rateLimit']);
  const { createSession, sessionFor } = createSessionAccess({ sessions });
  const { loginKey, loginLockedOut, noteLoginFailure } = createLoginBudget({ rateLimit });
  return { createSession, sessionFor, loginKey, loginLockedOut, noteLoginFailure };
}

/**
 * The session routes, the three authenticated routers, and the guardian and organisation accounts. Returns the
 * routers, `guardianManagedOnly`, and the organisation as the apps see it (`orgSafe`) with whether its safeguarding
 * certification stands.
 */
export function createAccounts(deps) {
  const d = strictContext(
    'createAccounts',
    needs('createAccounts', deps, [
      'app',
      'sessions',
      'users',
      'orgs',
      'guardians',
      'clubSetup',
      'safetyAudit',
      'byId',
      'findPlayer',
      'createSession',
      'sessionFor',
      'loginKey',
      'loginLockedOut',
      'noteLoginFailure',
      'devLogins',
      'mailer',
      'idv',
      'seam',
      'unit',
      'nextId',
      'broadcast',
    ]),
  );
  const { app, sessionFor, createSession, devLogins, unit, nextId, safetyAudit } = d;
  const { orgSafe, safeguardingCertified } = createOrgViews({ clubSetup: d.clubSetup, safetyAudit });
  registerSessionRoutes({ app, sessions: d.sessions, sessionFor });
  const login = {
    createSession,
    loginLockedOut: d.loginLockedOut,
    noteLoginFailure: d.noteLoginFailure,
    devLogins,
    devLoginRefused,
  };
  const { orgRouter } = createOrgSession({ app, findOrg: d.byId.org, users: d.users, sessionFor });
  const { playerRouter, guardianManagedOnly } = createPlayerSession({ app, findPlayer: d.findPlayer, sessionFor });
  // Parents own every under-18 account: the account and its safeguarding gates (e-mail, ID, disclaimer).
  const { guardianRouter } = registerGuardianAccount({
    ...login,
    app,
    guardians: d.guardians,
    safetyAudit,
    unit,
    nextId,
    mailer: d.mailer,
    idv: d.idv,
    faultSeam: d.seam,
    sessionFor,
    loginKey: d.loginKey,
  });
  // The second-factor guards are shared with the MFA set-up routes (the enterprise domain).
  const mfaGuards = createMfaGuards();
  registerOrgAccount({
    ...login,
    app,
    orgs: d.orgs,
    users: d.users,
    safetyAudit,
    findOrg: d.byId.org,
    unit,
    nextId,
    broadcast: d.broadcast,
    mfaGuards,
    orgSafe,
    safeguardingCertified,
  });
  return { orgRouter, playerRouter, guardianRouter, guardianManagedOnly, orgSafe, safeguardingCertified, mfaGuards };
}

/**
 * The writes another domain makes on a player's record, each named for what happened; other domains get the players'
 * reads and these, never the repository, so none of them creates, erases or signs in a player or writes a list it
 * has no act for. Each returns what the repository's act returns. `recordSigning`: a completed signing sets the level
 * the player reached and the contract status and availability it implies, and adds its timeline lines in order.
 */
export function createPlayerRecord(deps) {
  const { players } = strictContext('createPlayerRecord', needs('createPlayerRecord', deps, ['players']));
  return Object.freeze({
    recordSigning(playerId, { level, contractStatus, availability, timeline = [] }) {
      players.setLevel(playerId, level);
      players.setAvailability(playerId, { contractStatus, availability });
      for (const entry of timeline) players.addItem(playerId, 'timeline', entry);
    },
    setLevel: (playerId, level) => players.setLevel(playerId, level),
    setAvailability: (playerId, { availability, contractStatus }) =>
      players.setAvailability(playerId, { availability, contractStatus }),
    setFootballCategory: (playerId, category) => players.setFootballCategory(playerId, category),
    setAcademyPlus: (playerId, on) => players.setAcademyPlus(playerId, on),
    setFirstTeamSeeker: (playerId, on) => players.setFirstTeamSeeker(playerId, on),
    setLocation: (playerId, location) => players.setLocation(playerId, location),
    setMedicalSharing: (playerId, shared) => players.setMedicalSharing(playerId, shared),
    setConditionStatus: (playerId, status) => players.setConditionStatus(playerId, status),
    addMedicalRecord: (playerId, record) => players.addItem(playerId, 'medical.records', record),
    awardBadge: (playerId, badge) => players.addItem(playerId, 'badges', badge),
    setBadges: (playerId, badges) => players.setItems(playerId, 'badges', badges),
    logActivity: (playerId, at) => players.addItem(playerId, 'activityLog', at),
    addTimelineEntry: (playerId, entry) => players.addItem(playerId, 'timeline', entry),
    recordAttendance: (playerId, entry) => players.addItem(playerId, 'attendance', entry),
    addMedia: (playerId, item) => players.addItem(playerId, 'media', item),
    annotateMedia: (playerId, mediaId, patch) => players.patchItem(playerId, 'media', { id: mediaId }, patch),
    recordStats: (playerId, stats) => players.recordStats(playerId, stats),
    setSeasonHistory: (playerId, history) => players.setItems(playerId, 'seasonHistory', history),
    recordDrill: (playerId, drillId) => players.addItem(playerId, 'drills', drillId),
    recordDrillResult: (playerId, result) => players.addItem(playerId, 'drillResults', result),
    startProgramme: (playerId, track, at) => players.startProgramme(playerId, track, at),
    completeProgrammeSession: (playerId, entry) => players.addItem(playerId, 'programme.completed', entry),
    addExternalId: (playerId, entry) => players.addItem(playerId, 'externalIds', entry),
    setNotificationPrefs: (playerId, prefs) => players.setNotificationPrefs(playerId, prefs),
  });
}

/** The write another domain makes on a guardian's account: their notification preferences. */
export function createGuardianRecord(deps) {
  const { guardians } = strictContext('createGuardianRecord', needs('createGuardianRecord', deps, ['guardians']));
  return Object.freeze({
    setNotificationPrefs: (guardianId, prefs) => guardians.setNotificationPrefs(guardianId, prefs),
  });
}

/**
 * The writes another domain makes on an organisation: its standing (verified, suspended, the safeguarding contract,
 * the verified domain), the verification route's registration and revocation, the T&S-provisioned password, and the
 * lead MFA policy.
 */
export function createOrgRecord(deps) {
  const { orgs } = strictContext('createOrgRecord', needs('createOrgRecord', deps, ['orgs']));
  return Object.freeze({
    register: (org) => orgs.create(org),
    setStanding: (orgId, standing) => orgs.setStanding(orgId, standing),
    suspend: (orgId) => orgs.setStanding(orgId, { suspended: true }),
    verifyEmailDomain: (orgId, domain) => orgs.verifyEmailDomain(orgId, domain),
    revokeVerification: (orgId, at) => orgs.revokeVerification(orgId, at),
    clearVerificationRevocation: (orgId) => orgs.clearVerificationRevocation(orgId),
    provisionPassword: (orgId, hash) => orgs.setPasswordHash(orgId, hash),
    requireMfaForLeads: (orgId, on) => orgs.setMfaRequiredForLeads(orgId, on),
  });
}

/**
 * The writes another domain makes on a staff account: joining (an invitation, an agency's team, a verified
 * applicant), coming back, the e-mail and SSO link, delivery preferences, the second factor, and removal. A staff
 * account's role and recovery codes stay the identity domain's own.
 */
export function createStaffRecord(deps) {
  const { users } = strictContext('createStaffRecord', needs('createStaffRecord', deps, ['users']));
  return Object.freeze({
    add: (user) => users.create(user),
    restore: (userId, change) => users.restore(userId, change),
    setEmail: (userId, email) => users.setEmail(userId, email),
    linkSso: (userId, subject) => users.linkSso(userId, subject),
    setDeliveryPrefs: (userId, prefs) => users.setDeliveryPrefs(userId, prefs),
    startMfa: (userId, secret) => users.startMfa(userId, secret),
    enableMfa: (userId, enrolment) => users.enableMfa(userId, enrolment),
    disableMfa: (userId) => users.disableMfa(userId),
    remove: (userId, removal) => users.remove(userId, removal),
  });
}

/**
 * How another domain ends sessions: one session, every session of an account (a revoked reviewer), and a staff
 * member's own session by id. Minting a session is the identity domain's alone.
 */
export function createSessionEnds(deps) {
  const { sessions } = strictContext('createSessionEnds', needs('createSessionEnds', deps, ['sessions']));
  return Object.freeze({
    end: (sid) => sessions.revokeSid(sid),
    endAllFor: (kind, refId) => sessions.revokeFor(kind, refId),
    endOwn: (userId, sid) => sessions.revokeOwn(userId, sid),
  });
}

/**
 * The account routes that read other domains' records, so they are created after them: the player's account, a
 * guardian's children, the guardian ID review, the club directory, and a player's export and erasure. Erasure runs
 * each domain's `redactors` in order inside its unit. Returns `erasePlayer`.
 */
export function createAccountServices(deps) {
  const d = strictContext(
    'createAccountServices',
    needs('createAccountServices', deps, [
      'app',
      'playerRouter',
      'guardianRouter',
      'adminRouter',
      'players',
      'guardians',
      'orgs',
      'sessions',
      'codes',
      'safetyAudit',
      'mediaDeletions',
      'uploads',
      'findPlayer',
      'createSession',
      'loginLockedOut',
      'noteLoginFailure',
      'devLogins',
      'rateLimit',
      'unit',
      'afterCommit',
      'seam',
      'nextId',
      'broadcast',
      'notify',
      'ledgerAppend',
      'storage',
      'removeUploadChunks',
      'DATA_DIR',
      'checkSavedSearches',
      'publishedVouchesFor',
      'vouchesFor',
      'insightsFor',
      'viewHelpers',
      'ledgerView',
      'requestsFor',
      'requestForRecipient',
      'ledgerPageForPlayers',
      'ledgerFor',
      'threadsFor',
      'notificationFeed',
      'trialsForOrg',
      'pathwayRecord',
      'safeguardingCertified',
      'redactors',
    ]),
  );
  const { app, playerRouter, guardianRouter, players, guardians, codes, findPlayer, unit, seam, nextId } = d;
  const { broadcast, rateLimit, checkSavedSearches, insightsFor, ledgerView, requestsFor } = d;
  registerPlayerAccount({
    app,
    playerRouter,
    players,
    guardians,
    findPlayer,
    codes,
    unit,
    seam,
    nextId,
    rateLimit,
    broadcast,
    notify: d.notify,
    ledgerAppend: d.ledgerAppend,
    createSession: d.createSession,
    loginLockedOut: d.loginLockedOut,
    noteLoginFailure: d.noteLoginFailure,
    devLogins: d.devLogins,
    devLoginRefused,
    checkSavedSearches,
    publishedVouchesFor: d.publishedVouchesFor,
    vouchesFor: d.vouchesFor,
  });
  registerChildren({
    guardianRouter,
    players,
    guardians,
    findPlayer,
    codes,
    unit,
    nextId,
    rateLimit,
    broadcast,
    checkSavedSearches,
    insightsFor,
    requestsFor,
    ledgerPageForPlayers: d.ledgerPageForPlayers,
    ledgerView,
    viewHelpers: d.viewHelpers,
  });
  registerGuardianIdReview({ adminRouter: d.adminRouter, guardians, safetyAudit: d.safetyAudit, unit });
  registerClubDirectory({
    app,
    orgs: d.orgs,
    trialsForOrg: d.trialsForOrg,
    safeguardingCertified: d.safeguardingCertified,
    pathwayRecord: d.pathwayRecord,
  });
  const erasePlayer = createPlayerErasure({
    unit,
    afterCommit: d.afterCommit,
    seam,
    findPlayer,
    players,
    sessions: d.sessions,
    codes,
    mediaDeletions: d.mediaDeletions,
    uploads: d.uploads,
    storage: d.storage,
    removeUploadChunks: d.removeUploadChunks,
    dataDir: d.DATA_DIR,
    broadcast,
    redactors: d.redactors,
  });
  registerDataRights({
    playerRouter,
    guardianRouter,
    findPlayer,
    erasePlayer,
    requestForRecipient: d.requestForRecipient,
    notificationFeed: d.notificationFeed,
    insightsFor,
    ledgerView,
    requestsFor,
    threadsFor: d.threadsFor,
    ledgerFor: d.ledgerFor,
  });
  return { erasePlayer };
}
