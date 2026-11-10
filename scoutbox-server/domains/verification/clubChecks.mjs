// A club's own verification submissions: company-mailbox control, or the federation route for grassroots clubs on
// free e-mail. Either is one of the safeguarding requirements before a club can see under-18 players; the decision
// is Trust & Safety's.
import { reqText } from '../platform/input.mjs';
import { rateLimitedBody } from '../platform/rateLimit.mjs';
import { CLUB_SETUP_LIMITS } from '../../repositories/clubSetup.mjs';
import { grassrootsOrgOnly } from '../development/grassrootsClub.mjs';

// Free-mail domains don't prove domain control. Narrower than the claims' list (claims/shared.mjs), which also
// refuses `mail.` subdomains: a club's own mail.club.example host is a company mailbox here.
const FREE_MAIL = /@(gmail|googlemail|hotmail|outlook|yahoo|icloud|aol|proton|protonmail|gmx|live|msn)\./i;

export function registerClubChecks({ orgRouter, orgs, codes, clubSetup, mailer, rateLimit, unit, seam, broadcast }) {
  if (typeof orgs?.verifyEmailDomain !== 'function' || typeof rateLimit?.peek !== 'function') throw new TypeError('registerClubChecks needs the organisations repository and the rate limiter');

  orgRouter.post('/verification/email', async (req, res) => {
    const { email } = req.body || {};
    if (!reqText(email, 254) || !email.includes('@')) return res.status(400).json({ error: 'EMAIL_REQUIRED' });
    if (FREE_MAIL.test(email)) {
      return res.status(422).json({
        error: 'COMPANY_EMAIL_REQUIRED',
        message: 'Free email providers don\'t prove domain control. No club domain? Use federation verification instead — your federation registration is checked by Trust & Safety.',
      });
    }
    if (rateLimit.limited('email_challenge_request', req.org.id)) return res.status(429).json(rateLimitedBody('email_challenge_request'));
    // The challenge row is durable before the mail is sent; `secrets` keeps the plain code out of the persisted
    // outbox record. A mail that fails to send leaves the row to expire or be replaced.
    const { code } = codes.issueEmailChallenge(req.org.id, email);
    await mailer.send({
      to: email,
      subject: `Verify ${req.org.name} on ScoutBox`,
      text: `Your ScoutBox club verification code is ${code}.\n\nEntering it confirms ${req.org.name} controls this company mailbox — one of the safeguarding requirements before a club can see under-18 players.`,
      secrets: [code],
    });
    res.status(201).json({ sent: true, note: 'Enter the code from the mailbox to confirm domain control.' });
  });

  orgRouter.post('/verification/email/confirm', (req, res) => {
    const { code } = req.body || {};
    // Only a wrong code is charged against the budget. The budget is tested before the code is judged, so a correct
    // guess after it is gone is refused rather than rewarded.
    if (rateLimit.peek('email_challenge_confirm', req.org.id).remaining === 0) return res.status(429).json(rateLimitedBody('email_challenge_confirm'));
    const check = codes.checkEmailChallenge(req.org.id, code);
    if (check.status === 'none') {
      rateLimit.limited('email_challenge_confirm', req.org.id);
      return res.status(404).json({ error: 'CHALLENGE_NOT_FOUND', message: 'Request a fresh code — none is active for this club.' });
    }
    if (check.status === 'invalid') {
      rateLimit.limited('email_challenge_confirm', req.org.id);
      const { attemptsRemaining, invalidated } = codes.noteFailedEmailAttempt(req.org.id);
      return res.status(400).json({
        error: 'CODE_INVALID',
        message: invalidated ? 'That code doesn\'t match, and this challenge is now cancelled after too many wrong codes — request a fresh one.' : 'That code doesn\'t match — check the email.',
        attemptsRemaining,
      });
    }
    // A failure anywhere, the COMMIT included, keeps the challenge live so the retry lands both.
    const updated = unit(() => {
      const consumed = codes.consumeEmailChallenge(req.org.id, code);
      if (!consumed) throw new Error('email challenge: the challenge changed between the check and the confirmation');
      seam('email_challenge.confirm.after_consume');
      return orgs.verifyEmailDomain(req.org.id, consumed.email.split('@')[1]);
    });
    broadcast('orgs');
    res.json({ emailDomainVerified: true, emailDomain: updated.emailDomain });
  });

  // Replaced on resubmission.
  orgRouter.post('/verification/federation', (req, res) => {
    if (grassrootsOrgOnly(req, res)) return;
    const { federation, registrationId, contactEmail } = req.body || {};
    if (!federation || !registrationId) return res.status(400).json({ error: 'FEDERATION_REQUIRED' });
    if (!reqText(federation, CLUB_SETUP_LIMITS.federation)) return res.status(400).json({ error: 'FIELD_INVALID', field: 'federation', message: `federation is text of at most ${CLUB_SETUP_LIMITS.federation} characters.` });
    if (!reqText(registrationId, CLUB_SETUP_LIMITS.registrationId)) return res.status(400).json({ error: 'FIELD_INVALID', field: 'registrationId', message: `registrationId is text of at most ${CLUB_SETUP_LIMITS.registrationId} characters.` });
    const email = typeof contactEmail === 'string' ? contactEmail.trim() : contactEmail;
    if (!(email === undefined || email === null || email === '' || (typeof email === 'string' && email.length <= CLUB_SETUP_LIMITS.contactEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))) return res.status(400).json({ error: 'FIELD_INVALID', field: 'contactEmail', message: 'contactEmail is an e-mail address.' });
    clubSetup.federation.submit({ orgId: req.org.id, federation: federation.trim(), registrationId: registrationId.trim(), contactEmail: email || null, status: 'pending', submittedAt: Date.now() });
    broadcast('orgs');
    res.status(201).json({
      submitted: true,
      note: 'Trust & Safety cross-checks the registration with your federation. Verification (and with the safeguarding contract, U18 visibility) follows their approval.',
    });
  });
}
