// Open this checkout in Claude Desktop without submitting a prompt or changing permissions.
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
if (!fs.existsSync(path.join(root, 'CLAUDE.md'))) throw new Error('ScoutBox project instructions are missing.');
const url = new URL('claude://code/new');
url.searchParams.set('folder', root.replace(/\/$/, ''));
url.searchParams.set('q', 'Use this local ScoutBox checkout. Read CLAUDE.md, HANDOFF_CLAUDE_UI.md and the final approval in BRAND_RULES.md. Preserve the approved Player design from commit 99de825 and subsequent authorized changes. Confirm you can read the source and project instructions; do not redesign, push, merge or deploy.');
if (process.argv.includes('--print-url')) {
  console.log(url.href);
} else {
  if (process.platform !== 'darwin') throw new Error('This launcher is for macOS. Use --print-url to obtain the Claude Desktop link.');
  const result = spawnSync('/usr/bin/open', [url.href], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
