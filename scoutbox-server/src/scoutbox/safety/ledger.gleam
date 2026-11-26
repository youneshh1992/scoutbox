//// The Discovery Ledger (`ledger`): append-only. `user_id` and `actor_name` are stored exactly as the act names
//// them, so the record stays attributable after the account is removed.

import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/platform/effect
import scoutbox/platform/json_text
import scoutbox/platform/live_event
import scoutbox/platform/paging.{type Page, IntKey}
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/box_cam_disputes as dispute_row
import scoutbox/rows/box_cam_prefs as prefs_row
import scoutbox/rows/combine_attempts as attempt_row
import scoutbox/rows/id
import scoutbox/rows/ledger as row
import scoutbox/rows/passport_shares as share_row
import scoutbox/vocab/box_target_type.{type BoxTargetType}
import scoutbox/vocab/party.{type Party}
import scoutbox/vocab/playing_level.{type PlayingLevel}
import sqlight

pub type Type =
  row.Type

/// What happened, with its detail. A type whose rows carry a detail (`detail_keys`) has its own constructor, so its
/// row can't be written with another type's detail or none; every other type is `Plain`.
pub type Event {
  Plain(Type)
  BoxAssignmentCancelled(assignment: id.BoxAssignmentId)
  BoxAssignmentCreated(drill_id: String, target: BoxTargetType, value: Float)
  BoxChallengePublished(challenge: id.BoxChallengeId, drill_id: String)
  BoxClipSaved(session: id.BoxSessionId, media: id.MediaId)
  BoxPrefsChanged(
    by: Party,
    share: prefs_row.ShareDevelopmentActivity,
    retain_clips: Bool,
  )
  BoxResultInvalidated(
    session: id.BoxSessionId,
    dispute: id.BoxDisputeId,
    outcome: dispute_row.ResolutionOutcome,
  )
  BoxResultRestored(session: id.BoxSessionId, reason: String)
  /// `protocol` is the protocol id at its version (`combine-box-touch-60@1`).
  CombineAttemptCompleted(
    attempt: id.CombineAttemptId,
    protocol: String,
    state: attempt_row.CombineState,
  )
  CombineRequestCompleted(request: id.CombineRequestId)
  CombineRequestCreated(request: id.CombineRequestId, protocols: List(String))
  LevelReview(from: PlayingLevel, to: PlayingLevel, reason: String)
  /// The TypeScript server declares a `trialId` for this row but never writes one, so neither does this.
  OpenTrialPosted
  /// A view through a share link says so (`via: "share"`); one through the club's own route carries no detail.
  PassportRecruitmentView(through_share: Bool)
  PassportShareCreated(mode: share_row.Mode, share: id.PassportShareId)
  PassportShareRevoked(share: id.PassportShareId, by: share_row.RevokedByKind)
  /// `action` is the decision as the request named it (`confirm`, `reject`, …).
  VerificationDecision(claim: id.ClaimId, action: String)
  VerificationRootApproved(request: id.RootRequestId)
}

pub type Entry {
  Entry(
    event: Event,
    player_id: Option(id.PlayerId),
    org_id: Option(id.OrgId),
    org_name: Option(String),
    user_id: Option(id.OrgUserId),
    actor_name: Option(String),
  )
}

/// A stored row with the protocols its detail names (`ledger_protocols`), as the readers return it.
pub type Logged {
  Logged(row: row.Row, protocols: List(String))
}

/// The keys a type's detail carries, in the order it is written (the TypeScript server's `LEDGER_DETAIL`,
/// `spec/repositories/safetyAudit.json`); empty for a type that carries none.
pub fn detail_keys(t: Type) -> List(String) {
  case t {
    row.BoxAssignmentCancelled -> ["assignmentId"]
    row.BoxAssignmentCreated -> ["drillId", "target"]
    row.BoxChallengePublished -> ["challengeId", "drillId"]
    row.BoxClipSaved -> ["sessionId", "mediaId"]
    row.BoxPrefsChanged -> ["by", "share", "retainClips"]
    row.BoxResultInvalidated -> ["sessionId", "disputeId", "outcome"]
    row.BoxResultRestored -> ["sessionId", "reason"]
    row.CombineAttemptCompleted -> ["attemptId", "protocol", "state"]
    row.CombineRequestCompleted -> ["requestId"]
    row.CombineRequestCreated -> ["requestId", "protocols"]
    row.LevelReview -> ["from", "to", "reason"]
    row.OpenTrialPosted -> ["trialId"]
    row.PassportRecruitmentView -> ["via"]
    row.PassportShareCreated -> ["mode", "shareId"]
    row.PassportShareRevoked -> ["shareId", "by"]
    row.VerificationDecision -> ["claimId", "action"]
    row.VerificationRootApproved -> ["request"]
    _ -> []
  }
}

/// The row type an event is written as.
pub fn type_of(event: Event) -> Type {
  case event {
    Plain(t) -> t
    BoxAssignmentCancelled(..) -> row.BoxAssignmentCancelled
    BoxAssignmentCreated(..) -> row.BoxAssignmentCreated
    BoxChallengePublished(..) -> row.BoxChallengePublished
    BoxClipSaved(..) -> row.BoxClipSaved
    BoxPrefsChanged(..) -> row.BoxPrefsChanged
    BoxResultInvalidated(..) -> row.BoxResultInvalidated
    BoxResultRestored(..) -> row.BoxResultRestored
    CombineAttemptCompleted(..) -> row.CombineAttemptCompleted
    CombineRequestCompleted(..) -> row.CombineRequestCompleted
    CombineRequestCreated(..) -> row.CombineRequestCreated
    LevelReview(..) -> row.LevelReview
    OpenTrialPosted -> row.OpenTrialPosted
    PassportRecruitmentView(..) -> row.PassportRecruitmentView
    PassportShareCreated(..) -> row.PassportShareCreated
    PassportShareRevoked(..) -> row.PassportShareRevoked
    VerificationDecision(..) -> row.VerificationDecision
    VerificationRootApproved(..) -> row.VerificationRootApproved
  }
}

/// The detail columns an event fills, and the protocols it names.
fn with_detail(new: row.New, event: Event) -> #(row.New, List(String)) {
  let text = Some
  case event {
    Plain(t) ->
      case plain_problem(t) {
        None -> #(new, [])
        Some(problem) -> panic as problem
      }
    BoxAssignmentCancelled(a) -> #(
      row.New(..new, detail_assignment_id: text(id.box_assignment_to_string(a))),
      [],
    )
    BoxAssignmentCreated(drill, target, value) -> #(
      row.New(
        ..new,
        detail_drill_id: text(drill),
        detail_target_type: text(box_target_type.to_string(target)),
        detail_target_value: Some(value),
      ),
      [],
    )
    BoxChallengePublished(c, drill) -> #(
      row.New(
        ..new,
        detail_challenge_id: text(id.box_challenge_to_string(c)),
        detail_drill_id: text(drill),
      ),
      [],
    )
    BoxClipSaved(session, media) -> #(
      row.New(
        ..new,
        detail_session_id: text(id.box_session_to_string(session)),
        detail_media_id: text(id.media_to_string(media)),
      ),
      [],
    )
    BoxPrefsChanged(by, share, retain) -> #(
      row.New(
        ..new,
        detail_by: text(party.to_string(by)),
        detail_share: text(prefs_row.share_development_activity_to_string(share)),
        detail_retain_clips: Some(retain),
      ),
      [],
    )
    BoxResultInvalidated(session, dispute, outcome) -> #(
      row.New(
        ..new,
        detail_session_id: text(id.box_session_to_string(session)),
        detail_dispute_id: text(id.box_dispute_to_string(dispute)),
        detail_outcome: text(dispute_row.resolution_outcome_to_string(outcome)),
      ),
      [],
    )
    BoxResultRestored(session, reason) -> #(
      row.New(
        ..new,
        detail_session_id: text(id.box_session_to_string(session)),
        detail_reason: text(reason),
      ),
      [],
    )
    CombineAttemptCompleted(attempt, protocol, state) -> #(
      row.New(
        ..new,
        detail_attempt_id: text(id.combine_attempt_to_string(attempt)),
        detail_protocol: text(protocol),
        detail_state: text(attempt_row.combine_state_to_string(state)),
      ),
      [],
    )
    CombineRequestCompleted(request) -> #(
      row.New(
        ..new,
        detail_request_id: text(id.combine_request_to_string(request)),
      ),
      [],
    )
    CombineRequestCreated(request, protocols) -> #(
      row.New(
        ..new,
        detail_request_id: text(id.combine_request_to_string(request)),
      ),
      protocols,
    )
    LevelReview(from, to, reason) -> #(
      row.New(
        ..new,
        detail_from_value: text(playing_level.to_string(from)),
        detail_to_value: text(playing_level.to_string(to)),
        detail_reason: text(reason),
      ),
      [],
    )
    OpenTrialPosted -> #(new, [])
    PassportRecruitmentView(through_share) -> #(
      row.New(..new, detail_via: case through_share {
        True -> text("share")
        False -> None
      }),
      [],
    )
    PassportShareCreated(mode, share) -> #(
      row.New(
        ..new,
        detail_mode: text(share_row.mode_to_string(mode)),
        detail_share_id: Some(share),
      ),
      [],
    )
    PassportShareRevoked(share, by) -> #(
      row.New(
        ..new,
        detail_share_id: Some(share),
        detail_by: text(share_row.revoked_by_kind_to_string(by)),
      ),
      [],
    )
    VerificationDecision(claim, action) -> #(
      row.New(..new, detail_claim_id: Some(claim), detail_action: text(action)),
      [],
    )
    VerificationRootApproved(request) -> #(
      row.New(..new, detail_root_request_id: Some(request)),
      [],
    )
  }
}

/// Why `Plain(t)` can't be written, when `t`'s rows carry a detail: the message `append` panics with, since an act
/// that builds one has a bug no request can cause.
pub fn plain_problem(t: Type) -> Option(String) {
  case detail_keys(t) {
    [] -> None
    keys ->
      Some(
        "ledger.append was given Plain(ledger_row."
        <> constructor_name(t)
        <> "), but a "
        <> row.type_to_string(t)
        <> " row carries a detail ("
        <> string.join(keys, ", ")
        <> "). Build the entry with ledger."
        <> constructor_name(t)
        <> "(…) instead, so its detail is written and the row reads back as the TypeScript server's does.",
      )
  }
}

/// `box_clip_saved` → `BoxClipSaved`, for the guard's message.
fn constructor_name(t: Type) -> String {
  row.type_to_string(t)
  |> string.split("_")
  |> list.map(string.capitalise)
  |> string.concat
}

/// Appends an entry and returns its id.
pub fn append(
  tx: Tx,
  entry: Entry,
  at: Int,
) -> Result(id.LedgerEntryId, Fail(e)) {
  let entry_type = type_of(entry.event)
  use id <- result.try(id.next_ledger_entry(tx))
  let #(new, protocols) =
    with_detail(
      row.New(
        ..row.new(id:, occurred_at: at, type_: entry_type),
        player_id: entry.player_id,
        org_id: entry.org_id,
        org_name: entry.org_name,
        user_id: entry.user_id,
        actor_name: entry.actor_name,
      ),
      entry.event,
    )
  use _ <- result.try(row.insert(tx, new))
  use _ <- result.map(
    list.index_map(protocols, fn(p, i) { #(p, i) })
    |> list.try_each(fn(pair) {
      store.run(
        tx,
        "INSERT INTO ledger_protocols (ledger_id, ord, protocol) VALUES (?, ?, ?)",
        [id.ledger_entry_sql(id), sqlight.int(pair.1), sqlight.text(pair.0)],
      )
    }),
  )
  store.emit(
    tx,
    effect.Live(live_event.Ledger(
      row.type_to_string(entry_type),
      option.map(entry.player_id, id.player_to_string),
    )),
  )
  id
}

// ----------------------------------------------------------------------------------------------- reads

/// A row's columns, then its protocols in order as a JSON list.
const logged_columns =
  row.columns
  <> ", (SELECT json_group_array(protocol ORDER BY ord) FROM ledger_protocols WHERE ledger_id = ledger.id)"

fn logged_decoder() -> decode.Decoder(Logged) {
  use r <- decode.then(row.decoder())
  use protocols <- decode.field(row.width, decode.string)
  case json.parse(protocols, decode.list(decode.string)) {
    Ok(list) -> decode.success(Logged(r, list))
    Error(_) -> decode.failure(Logged(r, []), "ledger_protocols as a JSON list")
  }
}

fn logged(
  read: Read,
  rest: String,
  args: List(sqlight.Value),
) -> Result(List(Logged), Fail(e)) {
  store.query(
    read,
    "SELECT " <> logged_columns <> " FROM ledger WHERE " <> rest,
    args,
    logged_decoder(),
  )
}

fn rows_page(
  read: Read,
  where: String,
  args: List(sqlight.Value),
  page: Page,
) -> Result(#(List(Logged), Option(String)), Fail(e)) {
  let #(after, after_args) = case page.after {
    Some([IntKey(seq)]) -> #(" AND seq < ?", [sqlight.int(seq)])
    _ -> #("", [])
  }
  use rows <- result.map(logged(
    read,
    where <> after <> " ORDER BY seq DESC LIMIT ?",
    list.flatten([args, after_args, [sqlight.int(page.limit + 1)]]),
  ))
  paging.page_of(rows, page.limit, fn(l) { [IntKey(l.row.seq)] })
}

/// A page of one club's ledger, newest first.
pub fn page_for_org(
  read: Read,
  org_id: id.OrgId,
  page: Page,
) -> Result(#(List(Logged), Option(String)), Fail(e)) {
  rows_page(read, "org_id = ?", [id.org_sql(org_id)], page)
}

/// A page of these players' ledger, newest first: a guardian's log of their children.
pub fn page_for_players(
  read: Read,
  player_ids: List(id.PlayerId),
  page: Page,
) -> Result(#(List(Logged), Option(String)), Fail(e)) {
  rows_page(
    read,
    "player_id IN (SELECT value FROM json_each(?))",
    [json.array(player_ids, id.player_json) |> json.to_string |> sqlight.text],
    page,
  )
}

/// One player's ledger, oldest first.
pub fn for_player(
  read: Read,
  player_id: id.PlayerId,
) -> Result(List(Logged), Fail(e)) {
  logged(read, "player_id = ? ORDER BY seq", [id.player_sql(player_id)])
}

/// One player's ledger with one organisation, oldest first: what a Proof Pack lists.
pub fn for_player_org(
  read: Read,
  player_id: id.PlayerId,
  org_id: id.OrgId,
) -> Result(List(Logged), Fail(e)) {
  logged(read, "player_id = ? AND org_id = ? ORDER BY seq", [
    id.player_sql(player_id),
    id.org_sql(org_id),
  ])
}

/// The first row between a player and an organisation: a signing's first qualifying interaction.
pub fn first_for_player_org(
  read: Read,
  player_id: id.PlayerId,
  org_id: id.OrgId,
) -> Result(Option(Logged), Fail(e)) {
  logged(read, "player_id = ? AND org_id = ? ORDER BY seq LIMIT 1", [
    id.player_sql(player_id),
    id.org_sql(org_id),
  ])
  |> result.map(fn(rows) { list.first(rows) |> option.from_result })
}

/// An organisation's whole ledger, oldest first: its audit export.
pub fn all_for_org(
  read: Read,
  org_id: id.OrgId,
) -> Result(List(Logged), Fail(e)) {
  logged(read, "org_id = ? ORDER BY seq", [id.org_sql(org_id)])
}

/// The players a club shortlisted, in the order it first did.
pub fn shortlisted_by(
  read: Read,
  org_id: id.OrgId,
) -> Result(List(id.PlayerId), Fail(e)) {
  store.query(
    read,
    "SELECT player_id FROM ledger WHERE org_id = ? AND type = 'shortlist' AND player_id IS NOT NULL GROUP BY player_id ORDER BY MIN(seq)",
    [id.org_sql(org_id)],
    decode.at([0], id.player_decoder()),
  )
}

/// One club's events counted for each type that starts with `prefix` (`view` also counts `view_*` types).
pub fn count_for_org(
  read: Read,
  org_id: id.OrgId,
  prefix: String,
) -> Result(Int, Fail(e)) {
  store.one(
    read,
    "SELECT COUNT(*) FROM ledger WHERE org_id = ? AND substr(type, 1, length(?)) = ?",
    [id.org_sql(org_id), sqlight.text(prefix), sqlight.text(prefix)],
    decode.at([0], decode.int),
  )
  |> result.map(result.unwrap(_, 0))
}

/// One club's busiest actors, most events first (ties: who acted first), at most `n`.
pub fn top_actors_for_org(
  read: Read,
  org_id: id.OrgId,
  n: Int,
) -> Result(List(#(String, Int)), Fail(e)) {
  store.query(
    read,
    "SELECT actor_name, COUNT(*) AS events FROM ledger WHERE org_id = ? AND actor_name IS NOT NULL AND actor_name <> '' GROUP BY actor_name ORDER BY events DESC, MIN(seq) LIMIT ?",
    [id.org_sql(org_id), sqlight.int(n)],
    {
      use name <- decode.field(0, decode.string)
      use events <- decode.field(1, decode.int)
      decode.success(#(name, events))
    },
  )
}

/// The whole ledger's events counted per actor name, organisation name and type, each group in the order of its first
/// event (TypeScript's `countsByActor`; reputation reads every club's, as there).
pub fn counts_by_actor(
  read: Read,
) -> Result(List(#(Option(String), Option(String), String, Int)), Fail(e)) {
  store.query(
    read,
    "SELECT actor_name, org_name, type, COUNT(*) AS n FROM ledger GROUP BY actor_name, org_name, type ORDER BY MIN(seq)",
    [],
    {
      use actor <- decode.field(0, decode.optional(decode.string))
      use org <- decode.field(1, decode.optional(decode.string))
      use type_ <- decode.field(2, decode.string)
      use n <- decode.field(3, decode.int)
      decode.success(#(actor, org, type_, n))
    },
  )
}

/// A ledger row as the organisation, the player or the guardian reads it. Its detail holds the keys its type
/// carries whose columns are set, in `detail_keys` order, or is null when none are (TypeScript's `decodeDetail`).
pub fn view(logged: Logged) -> Json {
  let l = logged.row
  let opt = json.nullable(_, json.string)
  json.object([
    #("id", id.ledger_entry_json(l.id)),
    #("ts", json.int(l.occurred_at)),
    #("type", row.type_to_json(l.type_)),
    #("playerId", json.nullable(l.player_id, id.player_json)),
    #("orgId", json.nullable(l.org_id, id.org_json)),
    #("orgName", opt(l.org_name)),
    #("userId", json.nullable(l.user_id, id.org_user_json)),
    #("scoutName", opt(l.actor_name)),
    #("detail", detail_json(logged)),
  ])
}

fn detail_json(logged: Logged) -> Json {
  let l = logged.row
  let text = fn(v: Option(String)) { option.map(v, json.string) }
  let fields =
    list.filter_map(detail_keys(l.type_), fn(key) {
      let value = case key {
        "assignmentId" -> text(l.detail_assignment_id)
        "drillId" -> text(l.detail_drill_id)
        "target" ->
          option.map(l.detail_target_type, fn(t) {
            json.object([
              #("type", json.string(t)),
              #("value", json.nullable(l.detail_target_value, json_text.number)),
            ])
          })
        "challengeId" -> text(l.detail_challenge_id)
        "sessionId" -> text(l.detail_session_id)
        "mediaId" -> text(l.detail_media_id)
        "by" -> text(l.detail_by)
        "share" -> text(l.detail_share)
        "retainClips" -> option.map(l.detail_retain_clips, json.bool)
        "disputeId" -> text(l.detail_dispute_id)
        "outcome" -> text(l.detail_outcome)
        "reason" -> text(l.detail_reason)
        "attemptId" -> text(l.detail_attempt_id)
        "protocol" -> text(l.detail_protocol)
        "state" -> text(l.detail_state)
        "requestId" -> text(l.detail_request_id)
        "protocols" ->
          case logged.protocols {
            [] -> None
            ps -> Some(json.array(ps, json.string))
          }
        "from" -> text(l.detail_from_value)
        "to" -> text(l.detail_to_value)
        "trialId" -> text(l.detail_trial_id)
        "via" -> text(l.detail_via)
        "mode" -> text(l.detail_mode)
        "shareId" -> option.map(l.detail_share_id, id.passport_share_json)
        "claimId" -> option.map(l.detail_claim_id, id.claim_json)
        "action" -> text(l.detail_action)
        "request" -> option.map(l.detail_root_request_id, id.root_request_json)
        other ->
          panic as {
            "ledger.detail_keys names a key view can't read: " <> other
          }
      }
      option.map(value, fn(v) { #(key, v) }) |> option.to_result(Nil)
    })
  case fields {
    [] -> json.null()
    _ -> json.object(fields)
  }
}
