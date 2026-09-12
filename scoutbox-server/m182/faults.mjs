/**
 * M18.2 — deterministic fault injection for development and test.
 *
 * "What does the Room look like when Trust is slow?" could not be answered
 * without editing server code. This is a middleware that answers it from an
 * environment variable, and that REFUSES to exist in production: the module
 * exports nothing usable when NODE_ENV=production, and a production boot with
 * SCOUTBOX_FAULTS set is a fatal configuration problem (capabilities.mjs).
 *
 *   SCOUTBOX_FAULTS='delay:/org/players/STAR/trust:1500;unavailable:/org/rooms/STAR'
 *
 * (STAR stands for a literal asterisk, which this comment cannot contain next
 * to a slash.) Rules are `kind:pathPattern[:arg]` separated by `;`. The
 * asterisk matches one path segment. Kinds:
 *
 *   delay:PATH:MS         respond normally after MS milliseconds
 *   unavailable:PATH      503 SOURCE_UNAVAILABLE, retryable
 *   timeout:PATH:MS       hold the request MS ms then 504 SOURCE_TIMEOUT, retryable
 *   retryable:PATH        503 SOURCE_UNAVAILABLE, retryable, first N hits only
 *                         (arg = N, default 1) — so "Try again" can succeed
 *   fatal:PATH            500 INTERNAL, NOT retryable
 *
 * The suites also set rules at runtime through POST /__faults (same guard),
 * so a single server can be walked through slow → failed → recovered.
 */

export const FAULT_KINDS = ['delay', 'unavailable', 'timeout', 'retryable', 'fatal'];

export function parseFaultRules(spec = '') {
  return String(spec).split(';').map((s) => s.trim()).filter(Boolean).map((rule) => {
    const [kind, pattern, arg] = rule.split(':');
    if (!FAULT_KINDS.includes(kind) || !pattern) throw new Error(`bad fault rule "${rule}"`);
    return { kind, pattern, arg: arg == null ? null : Number(arg), hits: 0 };
  });
}

const matches = (pattern, path) => {
  const p = pattern.split('/'); const q = path.split('/');
  if (p.length !== q.length) return false;
  return p.every((seg, i) => seg === '*' || seg === q[i]);
};

export function createFaultLayer({ env = process.env } = {}) {
  const production = (env.NODE_ENV ?? 'development') === 'production';
  let rules = [];
  const enabled = !production;

  if (enabled && env.SCOUTBOX_FAULTS) rules = parseFaultRules(env.SCOUTBOX_FAULTS);

  const middleware = (req, res, next) => {
    if (!enabled || rules.length === 0) return next();
    const path = String(req.originalUrl ?? req.url ?? '').split('?')[0];
    const rule = rules.find((r) => matches(r.pattern, path));
    if (!rule) return next();
    rule.hits += 1;
    const fail = (status, error, retryable, message) => res.status(status).json({
      error, message, retryable, simulated: true, requestId: req.correlationId ?? null,
    });
    switch (rule.kind) {
      case 'delay':
        return setTimeout(next, rule.arg ?? 1000);
      case 'unavailable':
        return fail(503, 'SOURCE_UNAVAILABLE', true, 'A source this request depends on is temporarily unavailable. Try again shortly.');
      case 'timeout':
        return setTimeout(() => fail(504, 'SOURCE_TIMEOUT', true, 'A source this request depends on did not answer in time. Try again shortly.'), rule.arg ?? 3000);
      case 'retryable':
        if (rule.hits <= (rule.arg ?? 1)) return fail(503, 'SOURCE_UNAVAILABLE', true, 'A source this request depends on is temporarily unavailable. Try again shortly.');
        return next();
      case 'fatal':
        return fail(500, 'INTERNAL', false, 'Something went wrong handling that request.');
      default:
        return next();
    }
  };

  /** Runtime control for the suites. Refused entirely in production. */
  function install(app) {
    app.use(middleware);
    if (!enabled) return;
    app.post('/__faults', (req, res) => {
      try {
        rules = parseFaultRules(req.body?.rules ?? '');
        res.json({ ok: true, rules: rules.map(({ kind, pattern, arg }) => ({ kind, pattern, arg })) });
      } catch (e) {
        res.status(400).json({ error: 'FAULT_RULE_INVALID', message: e.message });
      }
    });
  }

  return { enabled, install, middleware, rules: () => rules };
}
