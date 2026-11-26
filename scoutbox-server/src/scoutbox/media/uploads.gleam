//// Uploads (docs/final-port-steps.md, step 5.2). A client declares a file (its purpose, size, type and SHA-256) and is
//// handed a URL to PUT it to in object storage (`platform/blobs`); the bytes never pass through this server. Then
//// it names the upload (`uploadId`) to the domain route that makes a record of it, in place of the file itself.
////
//// That route calls `verify` before its unit (it asks storage) and `mark_used` inside it. Storage has already
//// refused bytes other than the declared ones, so `verify` checks only that the upload is the caller's, still
//// open and has arrived, and, for a purpose that checks content, that its leading bytes are the type declared.
//// A retry finds the upload used for the record it made, and answers with that record.

import gleam/bit_array
import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/access.{type OrgAccess, type PlayerAccess}
import scoutbox/platform/blobs
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/secrets
import scoutbox/platform/store.{type Fail, type Tx}
import scoutbox/rows/id
import scoutbox/rows/upload_intents as row
import scoutbox/rows/ver_evidence as evidence_row
import scoutbox/verification/claims
import sqlight
import wisp.{type Request, type Response}

/// Who an upload belongs to: only they can name it.
pub type Owner {
  Player(id.PlayerId)
  OrgUser(id.OrgUserId)
  /// The root application whose secret the applicant holds.
  Applicant(id.RootRequestId)
}

fn owner_columns(owner: Owner) -> #(row.OwnerKind, String) {
  case owner {
    Player(p) -> #(row.Player, id.player_to_string(p))
    OrgUser(u) -> #(row.OrgUser, id.org_user_to_string(u))
    Applicant(r) -> #(row.Applicant, id.root_request_to_string(r))
  }
}

/// What a purpose accepts. `sniffed`: its leading bytes must be the type declared.
pub type Policy {
  Policy(max_bytes: Int, mimes: List(String), sniffed: Bool)
}

pub fn policy(purpose: row.Purpose) -> Policy {
  case purpose {
    row.PlayerClip ->
      Policy(
        max_bytes: blobs.max_bytes,
        mimes: [
          "video/webm", "video/mp4", "video/quicktime", "image/jpeg",
          "image/png", "image/webp",
        ],
        sniffed: False,
      )
    row.VerificationEvidence | row.SigningDocument ->
      Policy(
        max_bytes: claims.evidence_max_bytes,
        mimes: list.map(evidence_row.mime_pairs, fn(p) { p.0 }),
        sniffed: True,
      )
  }
}

/// How long the upload URL lives: long enough for a slow phone to send 40 MiB.
const url_ms = 3_600_000

/// How long after its URL expires an upload can still be named: a PUT that started just before expiry finishes.
const grace_ms = 900_000

/// Open uploads an owner may hold at once: each can hold a file in storage until it expires.
pub const open_max = 10

const sniff_bytes = 16

pub type Declared {
  Declared(purpose: row.Purpose, size: Int, mime: String, sha256: String)
}

/// The fields that declare an upload, for the purposes this audience may upload; `next` continues the shape.
pub fn declared(
  purposes: List(row.Purpose),
  next: fn(Declared) -> input.Shape(a),
) -> input.Shape(a) {
  use purpose <- input.field(
    "purpose",
    input.required(input.one_of_these(row.purpose_pairs, purposes)),
  )
  let p = policy(purpose)
  use size <- input.field(
    "size",
    input.required(input.whole_number(1, p.max_bytes)),
  )
  use mime <- input.field(
    "mime",
    input.required(input.one_of(list.map(p.mimes, fn(m) { #(m, m) }))),
  )
  use sha256 <- input.field(
    "sha256",
    input.required(input.matching("[0-9a-f]{64}")),
  )
  next(Declared(purpose:, size:, mime:, sha256:))
}

/// The codes `declared`'s refusals carry, for `http.body`.
pub const codes = [#("mime", "TYPE_NOT_ALLOWED")]

/// The body a route takes when it only declares an upload.
pub fn shape(purposes: List(row.Purpose)) -> input.Shape(Declared) {
  use d <- declared(purposes)
  input.done(d)
}

/// `POST /player/uploads`: a player's clip.
pub fn for_player(ctx: Ctx, req: Request, p: PlayerAccess) -> Response {
  use d <- http.body(req, shape([row.PlayerClip]), codes)
  open(ctx, Player(p.player.row.id), d)
}

/// `POST /org/uploads`: a document for a claim or for a signing. The route that names it decides whether this
/// user may add it there.
pub fn for_org(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use d <- http.body(
    req,
    shape([row.VerificationEvidence, row.SigningDocument]),
    codes,
  )
  open(ctx, OrgUser(a.user.id), d)
}

/// Opens an upload for `owner` and answers where to PUT the file: `201 {uploadId, put: {url, headers},
/// expiresAt}`. The client sends exactly those headers, and the body must be exactly the declared bytes.
pub fn open(ctx: Ctx, owner: Owner, d: Declared) -> Response {
  let now = clock.now_ms()
  let #(kind, owner_id) = owner_columns(owner)
  let assert Ok(digest) = bit_array.base16_decode(d.sha256)
    as "the shape admits only hex"
  // Random, not from the counter: an id is also an object's key in storage, which must never repeat.
  let upload_id = id.upload_intent("upl-" <> secrets.random_hex(12))
  let opened =
    store.unit(ctx.store, fn(tx) {
      use held <- result.try(store.one(
        store.reading(tx),
        "SELECT COUNT(*) FROM upload_intents
         WHERE owner_kind = ? AND owner_id = ? AND status = 'open' AND expires_at > ?",
        [
          sqlight.text(row.owner_kind_to_string(kind)),
          sqlight.text(owner_id),
          sqlight.int(now),
        ],
        decode.at([0], decode.int),
      ))
      case result.unwrap(held, 0) >= open_max {
        True -> store.refuse(Nil)
        False ->
          row.insert(
            tx,
            row.new(
              id: upload_id,
              purpose: d.purpose,
              owner_kind: kind,
              owner_id:,
              size_bytes: d.size,
              mime: d.mime,
              sha256: d.sha256,
              status: row.Open,
              created_at: now,
              expires_at: now + url_ms + grace_ms,
            ),
          )
      }
    })
  case opened {
    Error(store.Refused(Nil)) ->
      http.error_message(
        429,
        "TOO_MANY_OPEN_UPLOADS",
        "Finish or wait out the uploads already open before starting another.",
      )
    Error(failure) -> http.internal(failure)
    Ok(Nil) -> {
      let put =
        blobs.presign_put(
          ctx.config.blobs,
          id.upload_intent_to_string(upload_id),
          size: d.size,
          mime: d.mime,
          sha256: digest,
          expires_seconds: url_ms / 1000,
          now_ms: now,
        )
      http.json(
        201,
        json.object([
          #("uploadId", id.upload_intent_json(upload_id)),
          #(
            "put",
            json.object([
              #("url", json.string(put.url)),
              #(
                "headers",
                json.object(
                  list.map(put.headers, fn(h) { #(h.0, json.string(h.1)) }),
                ),
              ),
            ]),
          ),
          #("expiresAt", json.string(clock.iso(now + url_ms))),
        ]),
      )
    }
  }
}

/// An upload a domain route may make a record of.
pub type Verified {
  /// Not used yet. `leading`: its first bytes, for a sniffed purpose (else empty).
  Fresh(upload: row.Row, leading: BitArray)
  /// Already made into this record: a retry, to be answered with it.
  AlreadyUsed(record_id: String)
}

pub type Refusal {
  /// No upload of this purpose is the caller's by that id.
  NotFound
  Expired
  /// Nothing has been PUT to its URL yet.
  NotReceived
  /// Storage holds something other than what was declared, or leading bytes of another type.
  Mismatch
  StorageUnavailable
}

/// Before the unit: the upload `upload_id` names, if it is `owner`'s, of `purpose`, open and in storage.
pub fn verify(
  ctx: Ctx,
  upload_id: id.UploadIntentId,
  purpose: row.Purpose,
  owner: Owner,
) -> Result(Verified, Refusal) {
  let now = clock.now_ms()
  let #(kind, owner_id) = owner_columns(owner)
  let found =
    store.read(ctx.store, fn(read) {
      store.one(
        read,
        "SELECT " <> row.columns <> " FROM upload_intents WHERE id = ?",
        [id.upload_intent_sql(upload_id)],
        row.decoder(),
      )
    })
  case found {
    Error(failure) -> {
      wisp.log_error("upload lookup: " <> string.inspect(failure))
      Error(StorageUnavailable)
    }
    Ok(Error(Nil)) -> Error(NotFound)
    Ok(Ok(u)) if u.owner_kind != kind || u.owner_id != owner_id ->
      Error(NotFound)
    Ok(Ok(u)) if u.purpose != purpose -> Error(NotFound)
    Ok(Ok(row.Row(status: row.Used, record_id: Some(record), ..))) ->
      Ok(AlreadyUsed(record))
    Ok(Ok(u)) if u.status == row.Expired || u.expires_at <= now -> Error(Expired)
    Ok(Ok(u)) -> in_storage(ctx, u, now)
  }
}

fn in_storage(ctx: Ctx, u: row.Row, now: Int) -> Result(Verified, Refusal) {
  let key = id.upload_intent_to_string(u.id)
  use object <- result.try(
    blobs.head(ctx.config.blobs, key, now) |> result.map_error(unavailable),
  )
  case object {
    None -> Error(NotReceived)
    Some(o) if o.size != u.size_bytes || o.mime != u.mime -> Error(Mismatch)
    Some(_) ->
      case policy(u.purpose).sniffed {
        False -> Ok(Fresh(u, <<>>))
        True -> {
          use leading <- result.try(
            blobs.read_range(
              ctx.config.blobs,
              key,
              offset: 0,
              length: sniff_bytes,
              now_ms: now,
            )
            |> result.map_error(unavailable),
          )
          case leading {
            None -> Error(NotReceived)
            Some(bytes) -> Ok(Fresh(u, bytes))
          }
        }
      }
  }
}

fn unavailable(problem: blobs.Problem) -> Refusal {
  wisp.log_error("upload storage: " <> string.inspect(problem))
  StorageUnavailable
}

/// Inside the unit that makes `record_id` of the upload: it is used, once. Another request that used it first
/// makes this one stale, and it runs again to find the upload `AlreadyUsed`.
pub fn mark_used(
  tx: Tx,
  upload_id: id.UploadIntentId,
  record_id: String,
  now: Int,
) -> Result(Nil, Fail(e)) {
  use changed <- result.try(store.write(
    tx,
    "UPDATE upload_intents SET status = 'used', record_id = ?, used_at = ?
     WHERE id = ? AND status = 'open' RETURNING id",
    [sqlight.text(record_id), sqlight.int(now), id.upload_intent_sql(upload_id)],
    decode.at([0], decode.string),
  ))
  case changed {
    [_] -> Ok(Nil)
    _ -> store.stale("upload " <> id.upload_intent_to_string(upload_id))
  }
}

/// The answer to a refusal, for any route that names an upload.
pub fn refused(refusal: Refusal) -> Response {
  case refusal {
    NotFound -> http.error(404, "UPLOAD_NOT_FOUND")
    Expired ->
      http.error_message(
        410,
        "UPLOAD_EXPIRED",
        "That upload has expired: start a new one.",
      )
    NotReceived ->
      http.error_message(
        409,
        "UPLOAD_NOT_RECEIVED",
        "The file hasn't arrived in storage yet: PUT it to the upload URL first.",
      )
    Mismatch -> http.error(409, "UPLOAD_MISMATCH")
    StorageUnavailable ->
      http.error_message(
        503,
        "STORAGE_UNAVAILABLE",
        "File storage didn't answer. Try again shortly.",
      )
  }
}

/// The text of an upload id a body names, as the id: a request body is a boundary.
pub fn upload_id_field() -> input.Check(id.UploadIntentId) {
  fn(v) { input.id_of(80)(v) |> result.map(id.upload_intent) }
}

// -------------------------------------------------------------------------------------------------- the sweep

/// The most expired uploads one sweep removes the files of; the next sweep carries on.
const removals_per_sweep = 100

/// The uploads' part of the sweep: every open upload past its time is expired, then the files of expired uploads
/// are removed from storage, between units, never inside one. A domain route that verified an upload the sweep then
/// expires finds it stale inside its unit (`mark_used`), so a file is never removed under a record. A removal that
/// fails is logged and tried again by the next sweep; one already done is never tried again.
///
/// An upload whose PUT began just before its URL expired and was still sending after the grace may land after its
/// removal: the bucket's lifecycle rule is the backstop for that file.
pub fn sweep(ctx: Ctx, now: Int) -> Result(Nil, Nil) {
  use _ <- result.try(
    store.unit(ctx.store, fn(tx) {
      store.run(
        tx,
        "UPDATE upload_intents SET status = 'expired' WHERE status = 'open' AND expires_at <= ?",
        [sqlight.int(now)],
      )
    })
    |> result.replace_error(Nil),
  )
  use due <- result.try(
    store.read(ctx.store, fn(read) {
      store.query(
        read,
        "SELECT id FROM upload_intents WHERE status = 'expired' AND removed_at IS NULL ORDER BY expires_at, id LIMIT ?",
        [sqlight.int(removals_per_sweep)],
        decode.at([0], id.upload_intent_decoder()),
      )
    })
    |> result.replace_error(Nil),
  )
  let removed =
    list.filter(due, fn(upload_id) {
      let key = id.upload_intent_to_string(upload_id)
      case blobs.delete(ctx.config.blobs, key, clock.now_ms()) {
        Ok(Nil) -> True
        Error(problem) -> {
          wisp.log_error(
            "upload sweep: " <> key <> ": " <> string.inspect(problem),
          )
          False
        }
      }
    })
  case removed {
    [] -> Ok(Nil)
    _ ->
      store.unit(ctx.store, fn(tx) {
        list.try_each(removed, fn(upload_id) {
          store.run(
            tx,
            "UPDATE upload_intents SET removed_at = ? WHERE id = ? AND status = 'expired' AND removed_at IS NULL",
            [sqlight.int(now), id.upload_intent_sql(upload_id)],
          )
        })
      })
      |> result.replace_error(Nil)
  }
}
