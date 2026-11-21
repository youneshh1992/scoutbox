// Writes test/fixtures/proxy_cases.json: SCOUTBOX_TRUST_PROXY values with what the TypeScript server makes of them
// (httpTrust.mjs parseTrustProxy: the state and the capability note), and requests with the client address Express
// settles on for each (`req.ip`, from proxy-addr over the parsed setting, as `app.set('trust proxy', …)` compiles
// it). The Gleam test checks platform/proxy_trust against every case. Regenerate with `node dev/proxy_cases.mjs`.
//
// Forwarded entries are written as proxies write them. proxy-addr also reads IPv4 in other notations (`127.1`
// written as one number, say) as an address, which this server doesn't: docs/known-issues.md.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '../../../scoutbox/scoutbox-server');
const require = createRequire(path.join(SERVER, 'package.json'));
const { parseTrustProxy } = await import(path.join(SERVER, 'httpTrust.mjs'));
const { compileTrust } = require('express/lib/utils');
const proxyaddr = require('proxy-addr');

const SETTINGS = [
  null,
  '',
  '  ',
  '0',
  'false',
  'OFF',
  'no',
  'true',
  'ALL',
  '1',
  '2',
  '3',
  '00',
  '007',
  ' 2 ',
  'loopback',
  'linklocal',
  'uniquelocal',
  'loopback, 10.0.0.0/8',
  'loopback,,10.0.0.0/8',
  '10.0.0.0/8',
  '10.1.2.3',
  '10.0.0.0/08',
  '192.168.0.0/16, 172.16.0.0/12',
  '::1',
  '::ffff:127.0.0.1',
  '::ffff:127.0.0.1/104',
  '::ffff:0:0/96',
  '2001:db8::/32',
  'fe80::1%eth0',
  'fc00::/7, 10.0.0.0/8',
  '1:2:3:4:5:6:7::',
  '::',
  'fly',
  'yes',
  'true, 10.0.0.1',
  '10.0.0.0/33',
  '10.0.0.0/0',
  '::/0',
  '::/129',
  '10.0.0.0/x',
  '10.0.0.0/0008',
  '1.2.3',
  '01.2.3.4',
  '256.0.0.1',
  '1.2.3.4/8/2',
  ' , ',
  '1:2:3:4:5:6:7:8:9',
  '1::2::3',
  'gggg::1',
  'LOOPBACK',
];

const SOCKETS = ['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '10.1.2.3', '::ffff:a01:203', '203.0.113.50'];

const FORWARDED = [
  null,
  '',
  '203.0.113.7',
  '198.51.100.9, 203.0.113.7',
  '198.51.100.9,203.0.113.7',
  '  198.51.100.9 ,  10.0.0.5  ',
  '198.51.100.9, 10.0.0.5',
  '198.51.100.9, 10.0.0.5, 127.0.0.1',
  '198.51.100.9, 192.168.1.1, 172.20.0.1',
  '198.51.100.9,, 10.0.0.5',
  'unknown, 10.0.0.5',
  '198.51.100.9, unknown',
  '2001:db8::7, fe80::1',
  '2001:db8::7, ::1',
  '2001:db8::7, ::ffff:10.0.0.5',
  '198.51.100.9, fe80::1%eth0',
  '198.51.100.9, 169.254.3.3',
  '198.51.100.9, fd00::1',
  '1.1.1.1, 2.2.2.2, 3.3.3.3, 4.4.4.4',
];

const settings = SETTINGS.map((raw) => {
  const p = parseTrustProxy(raw ?? undefined);
  return { raw, state: p.state, note: p.note };
});

const requests = [];
for (const raw of SETTINGS) {
  const trust = compileTrust(parseTrustProxy(raw ?? undefined).setting);
  for (const socket of SOCKETS) {
    for (const forwarded of FORWARDED) {
      const req = { headers: forwarded === null ? {} : { 'x-forwarded-for': forwarded }, socket: { remoteAddress: socket } };
      requests.push({ raw, socket, forwarded, client: proxyaddr(req, trust) });
    }
  }
}

fs.writeFileSync(
  path.join(HERE, '../test/fixtures/proxy_cases.json'),
  `${JSON.stringify({ settings, requests }, null, 1)}\n`,
);
console.log(`proxy_cases.json: ${settings.length} settings, ${requests.length} requests`);
