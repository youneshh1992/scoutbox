// Guardian accounts and the safeguarding gates in front of every under-18 profile: a verified e-mail, a passed ID
// check and the accepted disclaimer, in that order, before a guardian can create a child (the child routes check
// the flags). Trust & Safety reviews each ID check and can revoke it.
//
// The flags are written only through the guardians repository's acts, and no act moves the e-mail or the
// disclaimer back.
import express from 'express';
import { readPage, sendPageError } from '../platform/paging.mjs';
import { reqText, badField, switchRefused } from '../platform/input.mjs';
import { hashCode } from '../../repositories/oneTimeCodes.mjs';
import { hashPassword, verifyPassword, randomCode } from '../../adapters.mjs';
import { timingSafeEqStr } from '../../m13/shared.mjs';
import { guardianSelfView, adminGuardianView } from '../../views/playerViews.mjs';

const idvView = (q) => ({
  id: q.id, guardianId: q.guardianId, guardianName: q.guardianName, documentType: q.documentType, documentRef: q.documentRef,
  provider: q.provider, reference: q.reference, ts: q.ts, status: q.status,
});

/**
 * The guardian's sign-up, e-mail verification and log-in on `app`, the session check, and the authenticated
 * `/guardian` router with the ID check, the disclaimer and `/me`. Returns `{ guardianAuth, guardianRouter }`; the
 * child-management routes (children.mjs) mount on that router.
 */
export function registerGuardianAccount({
  app, guardians, safetyAudit, unit, nextId, mailer, idv, faultSeam,
  createSession, sessionFor, loginKey, loginLockedOut, noteLoginFailure, devLogins, devLoginRefused,
}) {
  if (typeof guardians?.verifyEmail !== 'function' || typeof unit !== 'function') throw new TypeError('registerGuardianAccount needs the guardians repository and unit from the data layer');

  app.post('/auth/guardian/signup', async (req, res) => {
    const { name, email, password } = req.body || {};
    if (!reqText(name, 120) || !reqText(email, 254) || !email.includes('@')) return res.status(400).json({ error: 'NAME_AND_EMAIL_REQUIRED' });
    if (!password || String(password).length < 8) {
      return res.status(400).json({ error: 'PASSWORD_REQUIRED', message: 'Pick a password of at least 8 characters.' });
    }
    const emailInUse = () => res.status(409).json({ error: 'EMAIL_IN_USE', message: 'A guardian account with this email already exists — log in instead.' });
    if (guardians.emailTaken(email)) return emailInUse();
    const emailCode = randomCode(6);
    const record = {
      id: nextId('gd'), name, email,
      passwordHash: hashPassword(password),
      emailVerified: false,
      emailCodeHash: hashCode(emailCode),
      idVerified: false,
      disclaimerAccepted: false,
      createdAt: Date.now(),
    };
    // The row commits on its own; the e-mail goes out afterwards, never inside a transaction.
    let g;
    try { g = guardians.create(record); } catch (e) {
      if (e?.code === 'EMAIL_IN_USE') return emailInUse();
      if (e?.code === 'GUARDIAN_RECORD_INVALID') return res.status(400).json({ error: 'GUARDIAN_INVALID', message: String(e.message) });
      throw e;
    }
    await mailer.send({
      to: email,
      subject: 'Verify your ScoutBox guardian account',
      text: `Hi ${name},\n\nYour ScoutBox verification code is ${emailCode}.\n\nGuardian accounts own every under-18 profile on ScoutBox — verifying your email is the first of the safeguarding gates (email → ID → disclaimer) before any child profile can exist.`,
    });
    res.status(201).json({
      guardianId: g.id, guardian: guardianSelfView(g), token: createSession('guardian', g.id), emailVerificationSent: true,
      // The dev transport has no real inbox, so the code is returned to let the flow complete.
      ...(mailer.transport === 'dev-outbox' ? { devEmailCode: emailCode } : {}),
    });
  });

  app.post('/auth/guardian/verify-email', (req, res) => {
    const { guardianId, code } = req.body || {};
    const g = typeof guardianId === 'string' ? guardians.byId(guardianId) : null;
    if (!g) return res.status(404).json({ error: 'GUARDIAN_NOT_FOUND' });
    if (g.emailVerified) return res.json({ emailVerified: true });
    const codeHash = guardians.emailCodeHashOf(g.id);
    if (!code || !codeHash || !timingSafeEqStr(hashCode(code), codeHash)) {
      return res.status(400).json({ error: 'CODE_INVALID', message: 'That code doesn\'t match — check the email we sent you.' });
    }
    guardians.verifyEmail(g.id);
    res.json({ emailVerified: true });
  });

  app.post('/auth/guardian/login', (req, res) => {
    // A guardian can be named by id or by e-mail. The failed-login budget is charged against both the identifier
    // tried and the account it resolved to, or alternating the two would give a guesser two budgets.
    const tried = `guardian:${req.body?.guardianId ?? req.body?.email}`;
    if (loginLockedOut(res, tried)) return;
    const g = (typeof req.body?.guardianId === 'string' ? guardians.byId(req.body.guardianId) : null) ?? guardians.byEmail(req.body?.email);
    if (!g) { noteLoginFailure(tried); return res.status(404).json({ error: 'GUARDIAN_NOT_FOUND' }); }
    const canonical = `guardian:${g.id}`;
    const aliased = loginKey(canonical) !== loginKey(tried);
    if (aliased && loginLockedOut(res, canonical)) return;
    const hash = guardians.passwordHashOf(g.id);
    if (hash) {
      const check = verifyPassword(req.body?.password ?? '', hash);
      if (!check) {
        noteLoginFailure(tried);
        if (aliased) noteLoginFailure(canonical);
        return res.status(401).json({ error: 'BAD_PASSWORD', message: 'This account is password-protected.' });
      }
      if (check === 'upgrade') guardians.setPasswordHash(g.id, hashPassword(req.body.password));
    } else if (!devLogins) {
      return devLoginRefused(res);
    }
    res.json({ guardianId: g.id, guardian: guardianSelfView(g), token: createSession('guardian', g.id) });
  });

  function guardianAuth(req, res, next) {
    const session = sessionFor(req);
    const g = session?.kind === 'guardian' ? guardians.byId(session.refId) : null;
    if (!g) return res.status(401).json({ error: 'GUARDIAN_AUTH_REQUIRED', message: 'Log in again — this session is no longer valid.' });
    req.guardian = g;
    next();
  }

  const guardianRouter = express.Router();
  app.use('/guardian', guardianAuth, guardianRouter);

  guardianRouter.post('/verify-id', async (req, res, next) => {
    const { documentType, documentRef } = req.body || {};
    if (!documentType || !documentRef) {
      return res.status(400).json({ error: 'DOCUMENT_REQUIRED', message: 'ID verification needs a document type and reference.' });
    }
    if (!reqText(documentType, 60)) return badField(res, 'documentType'); // stored in the queue's text column
    const result = await idv.verify({ name: req.guardian.name, documentType, documentRef });
    if (!result.approved) {
      return res.status(422).json({ error: 'IDV_REJECTED', message: 'Identity verification did not pass — check the document details.' });
    }
    // Entered only after the provider answered: a transaction never spans the await. The flag and the review-queue
    // entry commit together.
    try {
      unit(() => {
        guardians.recordIdCheck(req.guardian.id, { reference: result.reference });
        faultSeam('guardian.verify_id.after_row');
        safetyAudit.idvQueue.add({
          id: nextId('idv'), guardianId: req.guardian.id, guardianName: req.guardian.name,
          documentType, documentRef: result.document.refLast4, provider: result.provider,
          reference: result.reference, ts: Date.now(), status: 'approved',
        });
      });
    } catch (e) {
      return next(e);
    }
    res.json({ idVerified: true, reference: result.reference });
  });

  guardianRouter.post('/disclaimer', (req, res) => {
    if (req.body?.accepted !== true) return res.status(400).json({ error: 'DISCLAIMER_NOT_ACCEPTED' });
    guardians.acceptDisclaimer(req.guardian.id, Date.now());
    res.json({ disclaimerAccepted: true });
  });

  guardianRouter.get('/me', (req, res) => res.json(guardianSelfView(req.guardian)));

  return { guardianAuth, guardianRouter };
}

/** Trust & Safety's guardian list with the ID-check queue, and the review that approves or revokes a check. */
export function registerGuardianIdReview({ adminRouter, guardians, safetyAudit, unit }) {
  adminRouter.get('/guardians', (req, res) => {
    let page;
    try { page = readPage(req.query, ['number']); } catch (e) { return sendPageError(res, e); }
    const { items, nextCursor } = guardians.page(page);
    res.json({ guardians: items.map(adminGuardianView), nextCursor, idvQueue: safetyAudit.idvQueue.all().map(idvView) });
  });

  adminRouter.post('/guardians/:id/idv', (req, res) => {
    const g = guardians.byId(req.params.id);
    if (!g) return res.status(404).json({ error: 'GUARDIAN_NOT_FOUND' });
    if (switchRefused(res, req.body?.approved, 'approved')) return;
    const approved = req.body.approved;
    // The review is recorded on the guardian's first queue entry.
    let stored;
    unit(() => {
      stored = guardians.reviewIdCheck(g.id, approved);
      const entry = safetyAudit.idvQueue.firstForGuardian(g.id);
      if (entry) safetyAudit.idvQueue.setStatus(entry.id, approved ? 'approved' : 'revoked');
    });
    res.json(adminGuardianView(stored));
  });
}
