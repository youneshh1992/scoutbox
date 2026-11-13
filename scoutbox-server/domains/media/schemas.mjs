/**
 * Media's request input: resumable uploads and the signed media link. The routes keep the codes the Player app
 * already reads (SIZE_REQUIRED, FILE_TOO_LARGE, TYPE_NOT_ALLOWED, TITLE_REQUIRED, CHUNK_DATA_REQUIRED).
 */
import * as v from 'valibot';
import { inputOrRefuse, oneOf, text, wholeNumber, wholeNumberText } from '../platform/schemas.mjs';
import { UPLOAD_LIMITS as L, UPLOAD_MIMES, isSha256 } from '../../repositories/uploadSessions.mjs';

const SIGNATURE_MAX = 128;
const SESSION_ID_MAX = 128;

export const MEDIA_INPUT = Object.freeze({
  // The route answers a size over the platform's cap with 413 FILE_TOO_LARGE.
  upload: v.strictObject({
    size: v.nullish(wholeNumber({ min: 1 })),
    mime: v.nullish(oneOf(UPLOAD_MIMES)),
    title: v.nullish(text(L.title)),
    sha256: v.nullish(
      v.pipe(
        v.string(),
        v.check((s) => s === '' || isSha256(s), "must be the file's SHA-256 digest: 64 hexadecimal characters"),
      ),
    ),
  }),
  // The route checks the decoded length against the chunk it expects.
  chunk: v.strictObject({ data: v.nullish(v.string()) }),
  // The link the server signs: expiry, session id and signature, each once.
  mediaLink: v.strictObject({
    e: v.optional(wholeNumberText()),
    v: v.optional(text(SESSION_ID_MAX)),
    s: v.optional(text(SIGNATURE_MAX)),
  }),
  none: v.strictObject({}),
});

const CODES_OF = Object.freeze({ upload: { mime: 'TYPE_NOT_ALLOWED' } });

/** The request input read with MEDIA_INPUT[name], or `undefined` once the 400 has been sent. */
export const mediaInput = (res, name, input, root = 'body') =>
  inputOrRefuse(res, MEDIA_INPUT[name], input ?? {}, { root, fieldCodes: CODES_OF[name] ?? {} });
