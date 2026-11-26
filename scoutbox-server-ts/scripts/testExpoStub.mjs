// TEST SUPPORT ONLY — preloaded into a test server (NODE_OPTIONS=--import=<this file>) so the
// live push transport (EXPO_ACCESS_TOKEN set) can be exercised without any external request: a
// request to exp.host is answered locally with 200 and its JSON body appended, one per line, to
// the file named by EXPO_STUB_LOG. Every other fetch is untouched. Never loaded by the server
// itself. (The mail counterpart is testSendgridStub.mjs.)
import fs from 'node:fs';

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (String(url).startsWith('https://exp.host/')) {
    fs.appendFileSync(process.env.EXPO_STUB_LOG, `${init.body}\n`);
    return new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
};
