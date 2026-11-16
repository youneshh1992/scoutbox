//// Signed media links (signedMedia.mjs). Every `/media/<id>` value leaving the API becomes a short-lived link
//// bound to the session that minted it, and the serve route checks that session's current standing on every
//// fetch, so possessing a link is never authority: a block, a suspension or a sign-out stops the link at once,
//// and lifting the block brings it back.

import gleam/bit_array
import gleam/bool
import gleam/bytes_tree
import gleam/crypto
import gleam/dynamic/decode
import gleam/int
import gleam/option.{type Option, None, Some}
import gleam/regexp
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/orgs
import scoutbox/identity/players
import scoutbox/identity/sessions.{type Session}
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/media
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/rows/id
import sqlight
import wisp.{type Request, type Response}

/// Short on purpose: clients refetch constantly, so links are re-minted long before they expire.
const ttl_ms = 900_000

const signature_max = 128

const session_id_max = 128

fn signature(
  key: String,
  media_id: String,
  expires: Int,
  sid: String,
) -> String {
  crypto.hmac(
    bit_array.from_string(
      media_id <> "." <> int.to_string(expires) <> "." <> sid,
    ),
    crypto.Sha256,
    bit_array.from_string(key),
  )
  |> bit_array.base64_url_encode(False)
  |> string.slice(0, 24)
}

/// A JSON string value that is exactly `/media/<id>`. Inside a JSON string every quote is escaped, so a quote
/// straight after `:`, `,` or `[` opens a value; one followed by `,`, `]` or `}` closes it, which leaves object
/// keys alone. The responses are gleam_json's compact output, which has no whitespace between tokens.
fn bare_path() -> regexp.Regexp {
  let assert Ok(re) =
    regexp.from_string("(?<=[:,\\[])\"/media/([A-Za-z0-9-]+)\"(?=[,\\]}])")
  re
}

/// Signs the media paths in a JSON response for the session the request presents. Without a session the paths
/// stay bare, and a bare path is refused when fetched without one.
pub fn sign(ctx: Ctx, req: Request, response: Response) -> Response {
  case response.body {
    wisp.Text(body) ->
      case string.contains(body, "\"/media/") {
        False -> response
        True ->
          case presented(ctx, req) {
            None -> response
            Some(session) ->
              wisp.Text(sign_body(
                ctx.config.media_key,
                body,
                session.sid,
                clock.now_ms(),
              ))
              |> wisp.set_body(response, _)
          }
      }
    _ -> response
  }
}

/// Exposed for its test.
pub fn sign_body(key: String, body: String, sid: String, now: Int) -> String {
  let expires = now + ttl_ms
  regexp.match_map(bare_path(), body, fn(m) {
    case m.submatches {
      [Some(media_id)] ->
        "\"/media/"
        <> media_id
        <> "?e="
        <> int.to_string(expires)
        <> "&s="
        <> signature(key, media_id, expires, sid)
        <> "&v="
        <> sid
        <> "\""
      _ -> m.content
    }
  })
}

fn presented(ctx: Ctx, req: Request) -> Option(Session) {
  case http.bearer(req) {
    Error(Nil) -> None
    Ok(token) ->
      store.read(ctx.store, fn(read) {
        sessions.by_token(read, token, clock.now_ms())
      })
      |> result.unwrap(None)
  }
}

type Link {
  Link(expires: Option(Int), sid: Option(String), signature: Option(String))
}

fn link_shape() -> input.Shape(Link) {
  use expires <- input.field(
    "e",
    input.optional(input.whole_number_text(0, 9_007_199_254_740_991)),
  )
  use sid <- input.field("v", input.optional(input.text(session_id_max)))
  use signature <- input.field("s", input.optional(input.text(signature_max)))
  input.done(Link(expires:, sid:, signature:))
}

/// `GET /media/:id`: the file, to a session that may see it now. The session is the one a valid signature names,
/// or else the bearer session.
pub fn serve(ctx: Ctx, req: Request, media_id: String) -> Response {
  let assert Ok(shape) = regexp.from_string("^[a-zA-Z0-9-]+$")
  use <- bool.lazy_guard(!regexp.check(shape, media_id), fn() {
    http.error(400, "BAD_MEDIA_ID")
  })
  let now = clock.now_ms()
  case store.read(ctx.store, deletion_queued(_, media_id)) {
    Error(failure) -> http.internal(failure)
    // The queue entry is the decision: a deleted owner's file is never served, whether or not it is gone yet.
    Ok(True) -> http.error(404, "MEDIA_NOT_FOUND")
    Ok(False) -> {
      use link <- http.query(req, link_shape(), [])
      let entitled =
        store.read(ctx.store, fn(read) {
          use session <- result.try(session_for(
            ctx,
            read,
            req,
            link,
            media_id,
            now,
          ))
          case session {
            None -> Ok(False)
            Some(session) -> may_access(read, session, id.media(media_id), now)
          }
        })
      case entitled {
        Error(failure) -> http.internal(failure)
        Ok(False) ->
          http.error_message(
            401,
            "MEDIA_AUTH_REQUIRED",
            "Media links are short-lived and tied to your login — refetch the profile for a fresh link.",
          )
        Ok(True) ->
          case media.read(ctx.config.data_dir, media_id) {
            Error(Nil) -> http.error(404, "MEDIA_NOT_FOUND")
            Ok(#(content_type, bytes)) ->
              wisp.response(200)
              |> wisp.set_header("content-type", content_type)
              |> wisp.set_body(wisp.Bytes(bytes_tree.from_bit_array(bytes)))
          }
      }
    }
  }
}

fn session_for(
  ctx: Ctx,
  read: Read,
  req: Request,
  link: Link,
  media_id: String,
  now: Int,
) -> Result(Option(Session), Fail(e)) {
  let signed = case link {
    Link(expires: Some(expires), sid: Some(sid), signature: Some(given))
      if sid != "" && expires > now
    ->
      case signature(ctx.config.media_key, media_id, expires, sid) == given {
        True -> Some(sid)
        False -> None
      }
    _ -> None
  }
  use by_link <- result.try(case signed {
    Some(sid) -> sessions.by_sid(read, sid, now)
    None -> Ok(None)
  })
  case by_link, http.bearer(req) {
    Some(session), _ -> Ok(Some(session))
    None, Ok(token) -> sessions.by_token(read, token, now)
    None, Error(Nil) -> Ok(None)
  }
}

/// One rule for signed and bearer fetches alike: the owner, the owner's guardian, or an organisation in good
/// standing that may see the owner and isn't blocked.
fn may_access(
  read: Read,
  session: Session,
  media_id: id.MediaId,
  now: Int,
) -> Result(Bool, Fail(e)) {
  use owner <- result.try(owner_of(read, media_id))
  case owner, session.holder {
    None, _ -> Ok(False)
    Some(owner), sessions.Player(player) -> Ok(owner == player)
    Some(owner), sessions.Guardian(guardian) -> {
      use player <- result.map(players.by_id(read, owner))
      case player {
        Some(p) -> p.row.guardian_id == Some(guardian)
        None -> False
      }
    }
    Some(owner), sessions.OrgStaff(org_id, _) -> {
      use org <- result.try(orgs.by_id(read, org_id))
      case org {
        None -> Ok(False)
        Some(org) if org.suspended -> Ok(False)
        Some(org) -> {
          use seen <- result.map(players.for_org(read, owner, org, now))
          case seen {
            Some(#(_, access)) -> access.visible && !access.blocked
            None -> False
          }
        }
      }
    }
    Some(_), sessions.Reviewer(_) -> Ok(False)
  }
}

fn owner_of(
  read: Read,
  media_id: id.MediaId,
) -> Result(Option(id.PlayerId), Fail(e)) {
  store.one(
    read,
    "SELECT player_id FROM player_media WHERE id = ?",
    [id.media_sql(media_id)],
    decode.at([0], id.player_decoder()),
  )
  |> result.map(option.from_result)
}

fn deletion_queued(read: Read, media_id: String) -> Result(Bool, Fail(e)) {
  store.one(
    read,
    "SELECT 1 FROM media_deletions WHERE media_id = ?",
    [sqlight.text(media_id)],
    decode.at([0], decode.int),
  )
  |> result.map(result.is_ok)
}
