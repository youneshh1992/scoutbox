// TEST SUPPORT ONLY — preloaded into a test server (NODE_OPTIONS=--import=<this file>) so the
// live mail transport (SENDGRID_API_KEY set) can be exercised without any external request: a
// request to api.sendgrid.com is answered locally with 202 and its JSON body appended, one per
// line, to the file named by SENDGRID_STUB_LOG. Every other fetch is untouched. Never loaded by
// the server itself.
import fs from 'node:fs';

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (String(url).startsWith('https://api.sendgrid.com/')) {
    fs.appendFileSync(process.env.SENDGRID_STUB_LOG, `${init.body}\n`);
    return new Response('', { status: 202 });
  }
  return realFetch(url, init);
};
