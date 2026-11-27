/**
 * Sending a file to the API: declare it, PUT it to the storage URL handed back, then name the `uploadId` to the
 * route that makes a record of it (`POST /player/media`, a signing document, evidence).
 *
 * The bytes never pass through the API. The PUT carries the declared length, type and SHA-256 under the URL's
 * signature, and storage refuses anything else, so the digest is computed here, before declaring.
 */

export type UploadPurpose = 'player_clip' | 'verification_evidence' | 'signing_document';

export interface UploadDeclaration {
  purpose: UploadPurpose;
  size: number;
  mime: string;
  sha256: string;
}

export interface OpenedUpload {
  uploadId: string;
  put: { url: string; headers: Record<string, string> };
  expiresAt: string;
}

/**
 * The app's own authenticated POST of a declaration to its audience's route (`/player/uploads`,
 * `/org/uploads`), throwing the app's usual error on a refusal.
 */
export type OpenUpload = (declaration: UploadDeclaration) => Promise<OpenedUpload>;

/** The types and sizes the server accepts for each purpose; a picker uses them to refuse early. */
export const UPLOAD_LIMITS: Record<UploadPurpose, { maxBytes: number; mimes: readonly string[] }> = {
  player_clip: {
    maxBytes: 40 * 1024 * 1024,
    mimes: ['video/webm', 'video/mp4', 'video/quicktime', 'image/jpeg', 'image/png', 'image/webp'],
  },
  verification_evidence: {
    maxBytes: 8 * 1024 * 1024,
    mimes: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'],
  },
  signing_document: {
    maxBytes: 8 * 1024 * 1024,
    mimes: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'],
  },
};

/** Storage refused the PUT (an expired URL, a dropped connection). Declaring again starts over. */
export class UploadFailed extends Error {
  readonly code = 'UPLOAD_FAILED';
  constructor(readonly status: number) {
    super(status === 0 ? 'The upload was interrupted.' : `Storage refused the upload (${status}).`);
  }
}

export interface UploadOptions {
  /** The API's origin, for a URL handed back as a path (the local store's are). Empty for same-origin. */
  apiBase?: string;
  /** The type to declare when the file doesn't say (`file.type` is empty for some pickers). */
  mime?: string;
  /** Called with the fraction sent, 0 to 1, where the platform can report it. */
  onProgress?: (fraction: number) => void;
}

/** SHA-256 of the bytes, as lowercase hex. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Declares `file`, sends it to storage, and resolves to the `uploadId` to name to the domain route. */
export async function uploadFile(
  open: OpenUpload,
  purpose: UploadPurpose,
  file: Blob,
  options: UploadOptions = {},
): Promise<string> {
  const bytes = await file.arrayBuffer();
  const mime = file.type || options.mime || 'application/octet-stream';
  const opened = await open({ purpose, size: bytes.byteLength, mime, sha256: await sha256Hex(bytes) });
  const url = new URL(opened.put.url, options.apiBase || globalThis.location?.origin).toString();
  // A browser sets the length itself and refuses to be told it.
  const headers = Object.entries(opened.put.headers).filter(([name]) => name.toLowerCase() !== 'content-length');
  const status = await send(url, headers, bytes, options.onProgress);
  if (status < 200 || status >= 300) throw new UploadFailed(status);
  options.onProgress?.(1);
  return opened.uploadId;
}

function send(
  url: string,
  headers: [string, string][],
  bytes: ArrayBuffer,
  onProgress?: (fraction: number) => void,
): Promise<number> {
  if (!onProgress || typeof XMLHttpRequest === 'undefined') {
    return fetch(url, { method: 'PUT', headers, body: bytes }).then(
      (res) => res.status,
      () => 0,
    );
  }
  // fetch can't report upload progress; XMLHttpRequest can.
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [name, value] of headers) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => resolve(xhr.status);
    xhr.onerror = () => resolve(0);
    xhr.onabort = () => resolve(0);
    xhr.send(bytes);
  });
}
