/**
 * The first two links of the copy-only rollback chain as ONE step, for the suites that prove the chain on a file this
 * build wrote: the S8d step-back (0018 → the four blobs) into a scratch copy, then the S8c tool on that copy into
 * `outDir`. Returns the S8c tool's result. A file that does not carry 0018 (a pre-S8d fixture) goes straight to the
 * S8c tool, so the suites keep one call. Kept with the chain until the merge (CLAUDE.md "Facts about the data").
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rollbackSigningsFollowUpsCopy } from './signingsFollowUpsRollback.mjs';
import { rollbackRecruitmentContactsOffersCopy } from './recruitmentContactsOffersRollback.mjs';
import { SIGNINGS_FOLLOWUPS_MIGRATION } from './signingsFollowUps.mjs';

const carries0018 = (file) => { const s = new DatabaseSync(file, { readOnly: true }); try { return !!s.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'data_migrations'").get() && !!s.prepare('SELECT 1 FROM data_migrations WHERE id = ?').get(SIGNINGS_FOLLOWUPS_MIGRATION); } finally { s.close(); } };

export function rollbackToPreS8c(file, outDir, opts = {}) {
  if (!fs.existsSync(file) || !carries0018(file)) return rollbackRecruitmentContactsOffersCopy(file, outDir, opts);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-s8d-to-s8c-'));
  try {
    const step = rollbackSigningsFollowUpsCopy(file, scratch);
    const result = rollbackRecruitmentContactsOffersCopy(step.output, outDir, opts);
    return { ...result, s8d: { signingPackages: step.signingPackages, signings: step.signings, followUps: step.followUps, outcomeReports: step.outcomeReports } };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
