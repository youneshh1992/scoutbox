// The specification tables the batteries check against (event registry, rate limits, error codes and their HTTP
// statuses, status vocabularies, …), written as JSON under e2e/support/spec/ from the modules that define them, so a
// battery can read them without importing the server. One file per module: `domains/platform/rateLimit.mjs` becomes
// `spec/platform/rateLimit.json`, holding the listed exports by name.
//
// Only plain data is written: a listed value holding a function, a Set or Map, a class instance or a non-finite number
// is refused, because it is behaviour rather than a table (its checks belong in a rules suite). Add a table here when
// a battery needs it.
//
//   node scripts/specSnapshot.mjs           rewrite e2e/support/spec/
//   node scripts/specSnapshot.mjs --check   exit 1 if a file is missing, stale or not listed (testE2ESupport runs it)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SPEC_DIR = path.join(SERVER_DIR, 'e2e', 'support', 'spec');

/** Module (relative to the server directory) → the exports written from it, in this order. */
export const SPEC = {
  'domains/platform/rateLimit.mjs': ['RATE_LIMIT_POLICY'],
  'domains/platform/eventRegistry.mjs': ['EVENT_REGISTRY', 'EVENT_NAMES'],
  'domains/platform/eventAudience.mjs': ['EVENT_AUDIENCE'],
  'domains/platform/notificationPrefs.mjs': ['CATEGORIES', 'TYPE_CATEGORY'],
  'domains/agents/core/shared.mjs': ['PERMISSIONS', 'FACETS', 'SCOPES', 'AGREEMENT_STATUSES', 'MAX_TERM_MONTHS'],
  'domains/agents/core/errors.mjs': ['AGENT_CORE_ERROR_HTTP'],
  'domains/agents/compliance/conflict.mjs': ['PERMITTED_WITH_CONSENT', 'CONFLICT_OUTCOMES'],
  'domains/agents/compliance/errors.mjs': ['COMPLIANCE_ERROR_HTTP'],
  'domains/agents/compliance/policy.mjs': ['POLICY_ACTIONS', 'MINOR_PATHWAY_PRODUCTION_ENABLED'],
  'domains/agents/compliance/policyVersions.mjs': ['SEEDED_POLICY_VERSIONS'],
  'domains/agents/integration/integration.mjs': ['HANDOFF_TTL_MS'],
  'domains/agents/transactions/errors.mjs': ['TRANSACTION_ERROR_HTTP'],
  'domains/agents/transactions/transaction.mjs': [
    'TRANSACTION_STATUSES',
    'TERMINAL_STATUSES',
    'DOCUMENT_TYPES',
    'DOCUMENT_VISIBILITY',
    'TIMELINE_AUDIENCES',
  ],
  'domains/discovery/shared.mjs': [
    'POSITIONS',
    'TRUST_BANDS',
    'PROHIBITED_BRIEF_FIELDS',
    'CHANGE_TYPES',
    'CHANGE_COPY',
    'POLICY',
  ],
  'domains/passport/shared.mjs': ['PROVENANCE', 'PROVENANCE_COPY'],
  'domains/recruitment/public.mjs': ['OPEN_ROOM_STATUSES'],
  'domains/recruitment/rooms/shared.mjs': [
    'ROOM_STATUSES',
    'TERMINAL_ROOM_STATUSES',
    'OPEN_ROOM_STATUSES',
    'ROOM_STATUS_LABELS',
    'ROOM_TRANSITIONS',
    'ROOM_PRIORITIES',
    'STATUS_EVIDENCE_REQUIRED',
    'SOURCE_CONTEXTS',
    'PRO_STAGES',
    'GRASSROOTS_STAGES',
    'REASON_CODES',
    'ALL_REASON_CODES',
    'PROHIBITED_REASON_CODES',
    'REVISITABLE_REASON_CODES',
    'LIMITS',
  ],
  'domains/recruitment/lifecycle/errors.mjs': ['LIFECYCLE_ERROR_HTTP'],
  'domains/recruitment/lifecycle/index.mjs': ['LIFECYCLE_INPUT_CODES'],
  'domains/recruitment/lifecycle/contact.mjs': ['CONTACT_STATUSES', 'CONTACT_LIMITS'],
  'domains/recruitment/lifecycle/contactRoutes.mjs': ['CONTACT_INPUT_CODES'],
  'domains/recruitment/lifecycle/decisionRoutes.mjs': ['DECISION_INPUT_CODES'],
  'domains/recruitment/lifecycle/evidence.mjs': ['EVIDENCE_KINDS'],
  'domains/recruitment/lifecycle/journeyModel.mjs': ['NEXT_ACTION_CODES'],
  'domains/recruitment/lifecycle/trial.mjs': ['TRIAL_LIMITS', 'TRIAL_WORKFLOW_STATES'],
  'domains/recruitment/lifecycle/trialRoutes.mjs': ['TRIAL_INPUT_CODES'],
  'domains/recruitment/analytics/funnels.mjs': ['FUNNEL_STAGES'],
  'domains/recruitment/analytics/metrics.mjs': [
    'METRICS',
    'METRIC_IDS',
    'FAMILY_IDS',
    'SMALL_N_MIN',
    'PERSON_DIMENSIONS',
    'ASSOCIATION_NOTE',
  ],
  'domains/recruitment/analytics/cohorts.mjs': ['EVIDENCE_REASON_CODES'],
  'domains/recruitment/analytics/index.mjs': ['DRILLDOWN_METRICS'],
  'domains/recruitment/offers/errors.mjs': ['OFFER_ERROR_HTTP', 'PUBLIC_ERROR_FIELDS'],
  'domains/recruitment/offers/offer.mjs': [
    'OFFER_LIMITS',
    'OFFER_INPUT_CODES',
    'MINOR_OFFER_PATHWAY_ENABLED',
    'OFFER_POLICY_VERSION',
  ],
  'domains/recruitment/signings/errors.mjs': ['SIGNING_ERROR_HTTP'],
  'domains/recruitment/signings/signing.mjs': ['SIGNING_CORRUPTION', 'SIGNING_INPUT_CODES'],
  'domain.ts': ['TRIAL_DATE_SYNTAX', 'TRIAL_DETAIL_LIMITS', 'TRIAL_REPORT_FIELDS'],
};

/** `spec/…/name.json` for a module path. */
export const specFileFor = (module) =>
  path.join(SPEC_DIR, `${module.replace(/^domains\//, '').replace(/\.(mjs|ts)$/, '')}.json`);

/** The places in `value` that are not plain JSON data. */
export function notData(value, at = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return [];
  if (typeof value === 'number') return Number.isFinite(value) ? [] : [`${at} is ${value}`];
  if (Array.isArray(value)) return value.flatMap((v, i) => notData(v, `${at}[${i}]`));
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null)
      return [`${at} is a ${value.constructor?.name ?? 'class instance'}`];
    return Object.entries(value).flatMap(([k, v]) => notData(v, `${at}.${k}`));
  }
  return [`${at} is a ${typeof value}`];
}

/** Map of file → text for every listed module. Throws on a missing export or a value that is not plain data. */
export async function specFiles() {
  const out = new Map();
  for (const [module, names] of Object.entries(SPEC)) {
    const m = await import(pathToFileURL(path.join(SERVER_DIR, module)).href);
    const body = { $source: module };
    for (const name of names) {
      if (!Object.hasOwn(m, name)) throw new Error(`specSnapshot: ${module} exports no ${name}`);
      const problems = notData(m[name], name);
      if (problems.length) throw new Error(`specSnapshot: ${module} ${name} is not plain data: ${problems.join('; ')}`);
      body[name] = m[name];
    }
    out.set(specFileFor(module), `${JSON.stringify(body, null, 2)}\n`);
  }
  return out;
}

/** Problems with the committed files: missing, stale, or not produced by any listed module. */
export async function specProblems() {
  const want = await specFiles();
  const problems = [];
  for (const [file, text] of want)
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text)
      problems.push(`${path.relative(SERVER_DIR, file)} is out of date`);
  const onDisk = fs.existsSync(SPEC_DIR)
    ? fs
        .readdirSync(SPEC_DIR, { recursive: true })
        .filter((f) => f.endsWith('.json'))
        .map((f) => path.join(SPEC_DIR, f))
    : [];
  for (const file of onDisk)
    if (!want.has(file)) problems.push(`${path.relative(SERVER_DIR, file)} is not listed in scripts/specSnapshot.mjs`);
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--check')) {
    const problems = await specProblems();
    for (const p of problems) console.error(`specSnapshot: ${p}; run node scripts/specSnapshot.mjs`);
    process.exit(problems.length ? 1 : 0);
  }
  fs.rmSync(SPEC_DIR, { recursive: true, force: true });
  for (const [file, text] of await specFiles()) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  console.log(`specSnapshot: wrote ${Object.keys(SPEC).length} files under e2e/support/spec/`);
}
