// Uploading a file as a client does (final-port-steps.md step 5): declare it where the caller's audience opens
// uploads, PUT the bytes to the URL handed back with exactly its headers, and name the `uploadId` to the route
// that makes a record of it. The same against R2 and the local store, whose URLs are paths on the API.
import crypto from 'node:crypto';

export const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** Where each audience opens an upload. `applicant` needs the application's id and secret. */
export const opener = {
  player: (token) => ({ path: '/player/uploads', headers: { authorization: `Bearer ${token}` }, body: {} }),
  org: (token) => ({ path: '/org/uploads', headers: { authorization: `Bearer ${token}` }, body: {} }),
  applicant: (requestId, applicantSecret) => ({
    path: `/auth/org/verification/apply/${requestId}/uploads`,
    headers: {},
    body: { applicantSecret },
  }),
};

/** Declares an upload: `{ status, body }` of the opening request. */
export async function declare(api, open, { purpose, bytes, mime, size, sha256 }) {
  const res = await fetch(`${api}${open.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...open.headers },
    body: JSON.stringify({
      ...open.body,
      purpose,
      size: size ?? bytes.length,
      mime,
      sha256: sha256 ?? sha256Hex(bytes),
    }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** PUTs `bytes` to an opened upload's URL with its headers, changed by `headers` (a value of null drops one). */
export async function put(api, opened, bytes, headers = {}) {
  const sent = { ...opened.put.headers, ...headers };
  for (const [k, v] of Object.entries(sent)) if (v === null) delete sent[k];
  const res = await fetch(new URL(opened.put.url, api), { method: 'PUT', headers: sent, body: bytes });
  return { status: res.status, text: await res.text() };
}

/** Declares and sends a file; its `uploadId`, to name to the route that records it. Throws if either step fails. */
export async function upload(api, open, { purpose, bytes, mime }) {
  const opened = await declare(api, open, { purpose, bytes, mime });
  if (opened.status !== 201) throw new Error(`upload refused: ${opened.status} ${JSON.stringify(opened.body)}`);
  const sent = await put(api, opened.body, bytes);
  if (sent.status !== 200) throw new Error(`storage refused the upload: ${sent.status} ${sent.text}`);
  return opened.body.uploadId;
}

/** Leading bytes that make a file of each evidence type, padded to `size`. */
export function fileOf(mime, size = 64) {
  const head = {
    'application/pdf': Buffer.from('%PDF-1.7\n'),
    'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    'image/webp': Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]),
  }[mime] ?? Buffer.alloc(0);
  return Buffer.concat([head, crypto.randomBytes(Math.max(size - head.length, 0))]);
}

/**
 * A PDF uploaded as a signing document by `token`'s user: its `uploadId`. When the upload itself is refused (a
 * session that no longer signs in, say), an id that names nothing, so the route answers as it does for that caller.
 */
export async function signingDocument(api, token, bytes) {
  try {
    return await upload(api, opener.org(token), { purpose: 'signing_document', bytes, mime: 'application/pdf' });
  } catch {
    return 'upl-000000000000000000000000';
  }
}

/** The bytes a response's `file: {mime, url}` links to, or null when it has none or storage refuses. */
export async function fileBytes(api, body) {
  if (!body?.file?.url) return null;
  const res = await fetch(new URL(body.file.url, api));
  return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
}
