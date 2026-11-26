// Deletes what earlier test runs left in the temporary directory once it is more than a day old. The runners give
// each file a folder of their own and remove it, but a battery or a dev script started by hand, a runner that was
// killed, or TEST_KEEP_TMP leaves its databases behind, and they add up to gigabytes. The test runners call this
// before they start.
//
//   sweepStaleRuns()                       the system temporary directory, older than a day
//   sweepStaleRuns({ dir, maxAgeMs, now }) for a test
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The names test runs give their temporary folders: the batteries, the unit suites, the runners and the dev tools. */
export const RUN_PREFIXES = ['sbx-', 'sb-', 'scoutbox-', 'shape-', 'probe-', 'combine-', 'perf-'];
const DAY_MS = 86_400_000;

/** Remove each folder in `dir` named by a run prefix and untouched for longer than `maxAgeMs`. Returns how many. */
export function sweepStaleRuns({ dir = os.tmpdir(), maxAgeMs = DAY_MS, now = Date.now() } = {}) {
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_PREFIXES.some((p) => entry.name.startsWith(p))) continue;
    const full = path.join(dir, entry.name);
    try {
      if (now - fs.statSync(full).mtimeMs <= maxAgeMs) continue;
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 3 });
      removed += 1;
    } catch {
      /* in use or already gone: the next sweep tries again */
    }
  }
  return removed;
}
