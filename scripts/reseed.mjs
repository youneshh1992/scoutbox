#!/usr/bin/env node
// Fresh demo seed WITHOUT destroying data: the current database and media are
// archived to scoutbox-server/data.bak-<timestamp>/ and a clean seed is
// created on the next server start. Never deletes anything.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scoutbox-server', 'data');
if (!fs.existsSync(dataDir)) {
  console.log('No database yet — the next server start seeds a fresh one.');
  process.exit(0);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${dataDir}.bak-${stamp}`;
fs.renameSync(dataDir, backup);
console.log(`Current data archived to ${backup}`);
console.log('The next server start creates a fresh seed. To restore, stop the server and rename the backup back to "data".');
