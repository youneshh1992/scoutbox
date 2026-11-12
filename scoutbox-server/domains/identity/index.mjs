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
 * The writes another domain makes on a player's record, each named for what happened. `recordSigning`: a completed
 * signing sets the level the player reached and the contract status and availability it implies, and adds its
 * timeline lines in order.
 */
export function createPlayerRecord(deps) {
  const { players } = strictContext('createPlayerRecord', needs('createPlayerRecord', deps, ['players']));
  return Object.freeze({
    recordSigning(playerId, { level, contractStatus, availability, timeline = [] }) {
      players.setLevel(playerId, level);
      players.setAvailability(playerId, { contractStatus, availability });
      for (const entry of timeline) players.addItem(playerId, 'timeline', entry);
    },
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
