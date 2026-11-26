/**
 * The attributed Trust & Safety reviewers: their identity, sign-in and session. A reviewer comes from the session,
 * never from a body field, a header or the shared admin key.
 */

import { guardRev, revMeta } from '../../platform/concurrency.mjs';
import { rateLimitedBody } from '../../platform/rateLimit.mjs';
import { sendComplianceError } from './errors.mjs';
import { filled } from '../../platform/schemas.mjs';
import { REVIEWER_ROLES } from '../../../repositories/compliancePolicies.mjs';
import { now } from '../../platform/clock.mjs';

export const REVIEWER_LEGACY_NOTE =
  'Records made through the shared admin key before reviewers had their own sign-in carry attribution "shared_admin_key" and are preserved as legacy/unattributed. They were never rewritten and are not authoritative compliance decisions.';

/** Registers the reviewer sign-in and the reviewer administration routes; returns the `/ts` session middleware. */
export function registerReviewers(ctx) {
  const {
    app,
    byReviewer,
    bySystem,
    compliancePolicies,
    createSession,
    devLogins,
    bumped,
    entry,
    hashPassword,
    hist,
    inputOr400,
    rateLimit,
    sessionFor,
    sessionEnds,
    tsRouter,
    unit,
    verifyPassword,
  } = ctx;
  const { reviewers } = compliancePolicies;
  const reviewerById = (id) => reviewers.byId(id);
  const publicReviewer = (r) => ({
    id: r.id,
    name: r.name,
    role: r.role,
    status: r.status,
    createdAt: r.createdAt,
    revokedAt: r.revokedAt ?? null,
    ...revMeta(r),
  });

  /** The caller has checked the id is free. */
  function createReviewer({ id, name, role, secret, createdBy }) {
    const r = {
      id,
      name,
      role,
      status: 'active',
      secretHash: hashPassword(secret),
      createdAt: now(),
      createdBy,
      revokedAt: null,
      revokedBy: null,
      rev: 1,
      revAt: now(),
      revBy: null,
      history: [],
    };
    hist(r, 'reviewer_created', createdBy, { role });
    return reviewers.create(r);
  }
  // An operator-provided root reviewer, never the shared key.
  if (process.env.TS_REVIEWER_BOOTSTRAP_ID && process.env.TS_REVIEWER_BOOTSTRAP_SECRET) {
    const id = String(process.env.TS_REVIEWER_BOOTSTRAP_ID).slice(0, 40);
    if (!reviewerById(id))
      createReviewer({
        id,
        name: String(process.env.TS_REVIEWER_BOOTSTRAP_NAME ?? process.env.TS_REVIEWER_BOOTSTRAP_ID).slice(0, 80),
        role: 'trust_safety_admin',
        secret: process.env.TS_REVIEWER_BOOTSTRAP_SECRET,
        createdBy: bySystem('bootstrap env'),
      });
  }
  // Seeded reviewers with known secrets, only when dev logins are on.
  if (devLogins && !reviewers.count()) {
    unit(() => {
      createReviewer({
        id: 'tsr-dev-admin',
        name: 'Priya Shah',
        role: 'trust_safety_admin',
        secret: 'dev-reviewer-admin',
        createdBy: bySystem('dev seed'),
      });
      createReviewer({
        id: 'tsr-dev-reviewer',
        name: 'Marcus Bell',
        role: 'trust_safety_reviewer',
        secret: 'dev-reviewer',
        createdBy: bySystem('dev seed'),
      });
      createReviewer({
        id: 'tsr-dev-admin2',
        name: 'Léa Fontaine',
        role: 'trust_safety_admin',
        secret: 'dev-reviewer-admin2',
        createdBy: bySystem('dev seed'),
      });
    });
  }

  /** Uniform refusal for an unknown id, a wrong secret and a revoked reviewer. */

  app.post('/auth/reviewer/login', (req, res) => {
    const b = inputOr400(res, 'reviewerLogin', req.body);
    if (!b) return;
    const id = b.reviewerId.trim();
    const secret = b.secret;
    // The failed-login budget is checked before the secret, keyed by the identifier whatever its state, so the 429
    // reveals nothing the uniform refusal withholds.
    const bucket = `reviewer:${id.toLowerCase()}`;
    if (rateLimit.peek('login_failure', bucket).limited) {
      return res.status(429).json(rateLimitedBody('login_failure'));
    }
    const r = reviewers.activeById(id);
    const good = !!r && !!verifyPassword(secret, r.secretHash);
    if (!good) {
      rateLimit.limited('login_failure', bucket);
      return sendComplianceError(
        res,
        { error: 'REVIEWER_CREDENTIALS_INVALID', message: 'Reviewer id and secret do not match an active reviewer.' },
        'login',
      );
    }
    const token = createSession('ts_reviewer', r.id);
    res.json({ token, reviewer: publicReviewer(r) });
  });

  /** The reviewer comes from the session, never from a body field or a header. */
  function reviewerAuth(req, res, next) {
    const session = sessionFor(req);
    if (session?.kind !== 'ts_reviewer')
      return sendComplianceError(
        res,
        {
          error: 'REVIEWER_AUTH_REQUIRED',
          message:
            'An authenticated Trust & Safety reviewer session is required. The shared admin key is not a reviewer.',
        },
        'reviewerAuth',
      );
    const r = reviewers.activeById(session.refId);
    if (!r) {
      sessionEnds.end(session.sid);
      return sendComplianceError(
        res,
        { error: 'REVIEWER_REVOKED', message: "This reviewer's access has been revoked." },
        'reviewerAuth',
      );
    }
    req.reviewer = r;
    next();
  }
  const requireReviewerRole = (req, res, role) => {
    if (req.reviewer.role === role || (role === 'trust_safety_reviewer' && REVIEWER_ROLES.includes(req.reviewer.role)))
      return true;
    sendComplianceError(
      res,
      { error: 'REVIEWER_ROLE_REQUIRED', role, message: `This action needs the ${role} role.` },
      'role',
    );
    return false;
  };
  const revokeReviewerSessions = (id) => {
    sessionEnds.endAllFor('ts_reviewer', id);
  };

  tsRouter.get('/me', (req, res) =>
    res.json({
      reviewer: publicReviewer(req.reviewer),
      attribution: 'authenticated_reviewer',
      note: 'Every authoritative compliance action is recorded against this identity.',
    }),
  );
  tsRouter.get('/reviewers', (req, res) => {
    if (!requireReviewerRole(req, res, 'trust_safety_admin')) return;
    res.json({ items: reviewers.all().map(publicReviewer), legacyNote: REVIEWER_LEGACY_NOTE });
  });
  tsRouter.post('/reviewers', (req, res) => {
    if (!requireReviewerRole(req, res, 'trust_safety_admin')) return;
    const b = inputOr400(res, 'newReviewer', req.body);
    if (!b) return;
    const { id, secret } = b;
    const name = b.name.trim();
    const role = b.role ?? 'trust_safety_reviewer';
    if (reviewerById(id)) return sendComplianceError(res, { error: 'REVIEWER_EXISTS' }, 'reviewers');
    const r = createReviewer({ id, name, role, secret, createdBy: byReviewer(req) });
    res.status(201).json({ reviewer: publicReviewer(r) });
  });
  tsRouter.post('/reviewers/:id/revoke', (req, res) => {
    if (!requireReviewerRole(req, res, 'trust_safety_admin')) return;
    const r = reviewerById(req.params.id);
    if (!r) return sendComplianceError(res, { error: 'REVIEWER_NOT_FOUND' }, 'reviewers');
    const b = inputOr400(res, 'reviewerRevocation', req.body);
    if (!b) return;
    if (r.status === 'revoked') return res.json({ reviewer: publicReviewer(r), idempotent: true });
    if (r.role === 'trust_safety_admin' && reviewers.activeCount('trust_safety_admin') <= 1)
      return sendComplianceError(
        res,
        { error: 'LAST_REVIEWER_ADMIN', message: 'At least one Trust & Safety administrator must remain.' },
        'reviewers',
      );
    if (!guardRev(req, res, r, { errorCode: 'REVIEWER_VERSION_CONFLICT', current: {} })) return;
    const out = unit(() => {
      const next = reviewers.revoke(
        r.id,
        { at: now(), by: { id: req.reviewer.id, name: req.reviewer.name } },
        {
          history: [entry('reviewer_revoked', byReviewer(req), { reason: filled(b.reason) })],
          ...bumped(req.reviewer),
        },
      );
      revokeReviewerSessions(r.id);
      return next;
    });
    res.json({ reviewer: publicReviewer(out) });
  });

  return { reviewerAuth, requireReviewerRole, publicReviewer };
}
