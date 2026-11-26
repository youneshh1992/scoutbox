//// Federation groups and their grants (repositories/groups.mjs, domains/groups/): the stored records, the queries
//// the routes and the audit export read, and what a grant shows its recipient.
////
//// A group's members are rows with an admin flag, so an admin is always a member. A grant shares one resource of
//// its owner (the whole shortlist, a case or an assessment) with named fellow members until it expires or is
//// revoked. What a recipient sees is worked out at every read: the owner must still own the resource, and each
//// player in it must be one the recipient may see on its own.

import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import scoutbox/identity/orgs.{type Org}
import scoutbox/identity/players
import scoutbox/platform/paging
import scoutbox/platform/store.{type Fail, type Read}
import scoutbox/recruitment/case_workspace
import scoutbox/rows/assessments as assessment_row
import scoutbox/rows/group_grant_recipients as recipient_row
import scoutbox/rows/group_grants as grant_row
import scoutbox/rows/group_members as member_row
import scoutbox/rows/group_pending_invites as invite_row
import scoutbox/rows/group_programmes as programme_row
import scoutbox/rows/group_shared_templates as template_row
import scoutbox/rows/groups as row
import scoutbox/rows/id
import scoutbox/rows/recruitment_cases as case_row
import scoutbox/safety/ledger
import scoutbox/scouting/assessments
import scoutbox/vocab/playing_level
import scoutbox/vocab/position
import sqlight

/// How many members and invites a group holds, and how many organisations one grant names.
pub const members_max = 500

pub const templates_max = 200

pub const programmes_max = 200

pub const name_max = 100

pub const programme_name_max = 100

pub const region_max = 80

pub const expires_days_min = 1

pub const expires_days_max = 180

/// The days a new grant runs for when its owner names none.
pub const default_days = 30

pub const day_ms = 86_400_000

pub type Group {
  Group(
    row: row.Row,
    members: List(member_row.Row),
    invites: List(invite_row.Row),
    templates: List(String),
    programmes: List(programme_row.Row),
  )
}

pub fn member_ids(g: Group) -> List(id.OrgId) {
  list.map(g.members, fn(m) { m.org_id })
}

pub fn admin_ids(g: Group) -> List(id.OrgId) {
  list.filter_map(g.members, fn(m) {
    case m.admin {
      True -> Ok(m.org_id)
      False -> Error(Nil)
    }
  })
}

pub fn is_member(g: Group, org_id: id.OrgId) -> Bool {
  list.contains(member_ids(g), org_id)
}

pub fn is_admin(g: Group, org_id: id.OrgId) -> Bool {
  list.contains(admin_ids(g), org_id)
}

pub fn is_invited(g: Group, org_id: id.OrgId) -> Bool {
  list.any(g.invites, fn(i) { i.org_id == org_id })
}

fn ids_json(ids: List(String)) -> sqlight.Value {
  sqlight.text(json.to_string(json.array(ids, json.string)))
}

/// The groups' child rows, in one query each, in the order they were written.
fn with_children(
  read: Read,
  rows: List(row.Row),
) -> Result(List(Group), Fail(e)) {
  let ids = ids_json(list.map(rows, fn(g) { id.group_to_string(g.id) }))
  use members <- result.try(store.query(
    read,
    "SELECT "
      <> member_row.columns
      <> " FROM group_members WHERE group_id IN (SELECT value FROM json_each(?)) ORDER BY group_id, rowid",
    [ids],
    member_row.decoder(),
  ))
  use invites <- result.try(store.query(
    read,
    "SELECT "
      <> invite_row.columns
      <> " FROM group_pending_invites WHERE group_id IN (SELECT value FROM json_each(?)) ORDER BY group_id, rowid",
    [ids],
    invite_row.decoder(),
  ))
  use templates <- result.try(store.query(
    read,
    "SELECT "
      <> template_row.columns
      <> " FROM group_shared_templates WHERE group_id IN (SELECT value FROM json_each(?)) ORDER BY group_id, rowid",
    [ids],
    template_row.decoder(),
  ))
  use programmes <- result.map(store.query(
    read,
    "SELECT "
      <> programme_row.columns
      <> " FROM group_programmes WHERE group_id IN (SELECT value FROM json_each(?)) ORDER BY group_id, rowid",
    [ids],
    programme_row.decoder(),
  ))
  list.map(rows, fn(g) {
    Group(
      row: g,
      members: list.filter(members, fn(m) { m.group_id == g.id }),
      invites: list.filter(invites, fn(i) { i.group_id == g.id }),
      templates: list.filter_map(templates, fn(t) {
        case t.group_id == g.id {
          True -> Ok(t.template_id)
          False -> Error(Nil)
        }
      }),
      programmes: list.filter(programmes, fn(p) { p.group_id == g.id }),
    )
  })
}

pub fn by_id(read: Read, gid: id.GroupId) -> Result(Option(Group), Fail(e)) {
  use found <- result.try(store.query(
    read,
    "SELECT " <> row.columns <> " FROM groups WHERE id = ?",
    [id.group_sql(gid)],
    row.decoder(),
  ))
  use groups <- result.map(with_children(read, found))
  list.first(groups) |> option.from_result
}

/// The groups the organisation is a member of, oldest first.
pub fn for_member(
  read: Read,
  org_id: id.OrgId,
) -> Result(List(Group), Fail(e)) {
  use found <- result.try(store.query(
    read,
    "SELECT "
      <> row.qualified("g")
      <> " FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.org_id = ? ORDER BY g.rowid",
    [id.org_sql(org_id)],
    row.decoder(),
  ))
  with_children(read, found)
}

/// The groups that invited the organisation, oldest invite first.
pub fn invites_for(
  read: Read,
  org_id: id.OrgId,
) -> Result(List(#(id.GroupId, String)), Fail(e)) {
  store.query(
    read,
    "SELECT g.id, g.name FROM group_pending_invites i JOIN groups g ON g.id = i.group_id WHERE i.org_id = ? ORDER BY i.rowid",
    [id.org_sql(org_id)],
    {
      use gid <- decode.field(0, id.group_decoder())
      use name <- decode.field(1, decode.string)
      decode.success(#(gid, name))
    },
  )
}

/// Do the two organisations share a group now?
pub fn share_a_group(
  read: Read,
  a: id.OrgId,
  b: id.OrgId,
) -> Result(Bool, Fail(e)) {
  store.one(
    read,
    "SELECT 1 FROM group_members a JOIN group_members b ON b.group_id = a.group_id WHERE a.org_id = ? AND b.org_id = ? LIMIT 1",
    [id.org_sql(a), id.org_sql(b)],
    decode.success(Nil),
  )
  |> result.map(result.is_ok)
}

/// A page of every group, newest first (Trust & Safety).
pub fn page(
  read: Read,
  page: paging.Page,
) -> Result(#(List(Group), Option(String)), Fail(e)) {
  let before = case page.after {
    Some([paging.IntKey(rid)]) -> Some(rid)
    _ -> None
  }
  use rows <- result.try(
    store.query(
      read,
      "SELECT "
        <> row.columns
        <> ", rowid FROM groups WHERE (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?",
      [
        sqlight.nullable(sqlight.int, before),
        sqlight.nullable(sqlight.int, before),
        sqlight.int(page.limit + 1),
      ],
      {
        use g <- decode.then(row.decoder())
        use rid <- decode.field(row.width, decode.int)
        decode.success(#(g, rid))
      },
    ),
  )
  let #(items, next) =
    paging.page_of(rows, page.limit, fn(p) { [paging.IntKey(p.1)] })
  use groups <- result.map(with_children(read, list.map(items, fn(p) { p.0 })))
  #(groups, next)
}

pub fn view_fields(g: Group) -> List(#(String, Json)) {
  [
    #("id", id.group_json(g.row.id)),
    #("name", json.string(g.row.name)),
    #("adminOrgIds", json.array(admin_ids(g), id.org_json)),
    #("memberOrgIds", json.array(member_ids(g), id.org_json)),
    #(
      "pendingInvites",
      json.array(g.invites, fn(i) {
        json.object([
          #("orgId", id.org_json(i.org_id)),
          #("invitedBy", id.org_json(i.invited_by_org_id)),
          #("at", json.int(i.invited_at)),
        ])
      }),
    ),
    #("sharedTemplateIds", json.array(g.templates, json.string)),
    #(
      "programmes",
      json.array(g.programmes, fn(p) {
        json.object([
          #("id", id.programme_json(p.id)),
          #("name", json.string(p.name)),
          #("region", json.nullable(p.region, json.string)),
          #("createdAt", json.int(p.created_at)),
        ])
      }),
    ),
    #("createdAt", json.int(g.row.created_at)),
  ]
}

pub fn view(g: Group) -> Json {
  json.object(view_fields(g))
}

// ------------------------------------------------------------------------------------------------------ grants

pub type Grant {
  Grant(row: grant_row.Row, to: List(id.OrgId))
}

pub fn is_live(g: Grant, now: Int) -> Bool {
  g.row.revoked_at == None && g.row.expires_at > now
}

/// Grants with their recipients, in the order `where` gives.
fn grants_where(
  read: Read,
  where: String,
  args: List(sqlight.Value),
) -> Result(List(Grant), Fail(e)) {
  use rows <- result.try(store.query(
    read,
    "SELECT " <> grant_row.columns <> " FROM group_grants " <> where,
    args,
    grant_row.decoder(),
  ))
  use to <- result.map(store.query(
    read,
    "SELECT "
      <> recipient_row.columns
      <> " FROM group_grant_recipients WHERE grant_id IN (SELECT value FROM json_each(?)) ORDER BY grant_id, ord",
    [ids_json(list.map(rows, fn(g) { id.group_grant_to_string(g.id) }))],
    recipient_row.decoder(),
  ))
  list.map(rows, fn(g) {
    Grant(
      g,
      list.filter_map(to, fn(r) {
        case r.grant_id == g.id {
          True -> Ok(r.org_id)
          False -> Error(Nil)
        }
      }),
    )
  })
}

pub fn grant_by_id(
  read: Read,
  grant_id: id.GroupGrantId,
) -> Result(Option(Grant), Fail(e)) {
  grants_where(read, "WHERE id = ?", [id.group_grant_sql(grant_id)])
  |> result.map(fn(found) { list.first(found) |> option.from_result })
}

const shared_with =
  "EXISTS (SELECT 1 FROM group_members a JOIN group_members b ON b.group_id = a.group_id WHERE a.org_id = group_grants.from_org_id AND b.org_id = ?)"

/// The grants naming the organisation that are live at `now` and whose owner still shares a group with it, newest
/// first.
pub fn live_received(
  read: Read,
  org_id: id.OrgId,
  now: Int,
) -> Result(List(Grant), Fail(e)) {
  grants_where(
    read,
    "WHERE id IN (SELECT grant_id FROM group_grant_recipients WHERE org_id = ?) AND revoked_at IS NULL AND expires_at > ? AND "
      <> shared_with
      <> " ORDER BY rowid DESC",
    [id.org_sql(org_id), sqlight.int(now), id.org_sql(org_id)],
  )
}

/// How many grants the organisation gave, and how many it can read now.
pub fn counts_for(
  read: Read,
  org_id: id.OrgId,
  now: Int,
) -> Result(#(Int, Int), Fail(e)) {
  let count = decode.at([0], decode.int)
  use given <- result.try(store.one(
    read,
    "SELECT COUNT(*) FROM group_grants WHERE from_org_id = ?",
    [id.org_sql(org_id)],
    count,
  ))
  use received <- result.map(store.one(
    read,
    "SELECT COUNT(*) FROM group_grants WHERE id IN (SELECT grant_id FROM group_grant_recipients WHERE org_id = ?) AND revoked_at IS NULL AND expires_at > ? AND "
      <> shared_with,
    [id.org_sql(org_id), sqlight.int(now), id.org_sql(org_id)],
    count,
  ))
  #(result.unwrap(given, 0), result.unwrap(received, 0))
}

/// How many grants the group has had, and how many are live at `now`.
pub fn counts_for_group(
  read: Read,
  gid: id.GroupId,
  now: Int,
) -> Result(#(Int, Int), Fail(e)) {
  store.one(
    read,
    "SELECT COUNT(*), COALESCE(SUM(CASE WHEN revoked_at IS NULL AND expires_at > ? THEN 1 ELSE 0 END), 0) FROM group_grants WHERE group_id = ?",
    [sqlight.int(now), id.group_sql(gid)],
    {
      use created <- decode.field(0, decode.int)
      use live <- decode.field(1, decode.int)
      decode.success(#(created, live))
    },
  )
  |> result.map(result.unwrap(_, #(0, 0)))
}

/// A page of the grants the organisation gave, newest first.
pub fn page_given(
  read: Read,
  org_id: id.OrgId,
  page: paging.Page,
) -> Result(#(List(Grant), Option(String)), Fail(e)) {
  let before = case page.after {
    Some([paging.IntKey(rid)]) -> Some(rid)
    _ -> None
  }
  use rows <- result.try(
    store.query(
      read,
      "SELECT id, rowid FROM group_grants WHERE from_org_id = ? AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?",
      [
        id.org_sql(org_id),
        sqlight.nullable(sqlight.int, before),
        sqlight.nullable(sqlight.int, before),
        sqlight.int(page.limit + 1),
      ],
      {
        use gid <- decode.field(0, decode.string)
        use rid <- decode.field(1, decode.int)
        decode.success(#(gid, rid))
      },
    ),
  )
  let #(items, next) =
    paging.page_of(rows, page.limit, fn(p) { [paging.IntKey(p.1)] })
  use grants <- result.map(
    grants_where(
      read,
      "WHERE id IN (SELECT value FROM json_each(?)) ORDER BY rowid DESC",
      [ids_json(list.map(items, fn(p) { p.0 }))],
    ),
  )
  #(grants, next)
}

/// Every grant the organisation gave, oldest first (the audit export).
pub fn all_given_by(
  read: Read,
  org_id: id.OrgId,
) -> Result(List(Grant), Fail(e)) {
  grants_where(read, "WHERE from_org_id = ? ORDER BY rowid", [
    id.org_sql(org_id),
  ])
}

/// Every grant naming the organisation, oldest first (the audit export).
pub fn all_received_by(
  read: Read,
  org_id: id.OrgId,
) -> Result(List(Grant), Fail(e)) {
  grants_where(
    read,
    "WHERE id IN (SELECT grant_id FROM group_grant_recipients WHERE org_id = ?) ORDER BY rowid",
    [id.org_sql(org_id)],
  )
}

/// A grant as its members and the audit export see it.
pub fn grant_fields(g: Grant) -> List(#(String, Json)) {
  let r = g.row
  [
    #("id", id.group_grant_json(r.id)),
    #("groupId", id.group_json(r.group_id)),
    #("fromOrgId", id.org_json(r.from_org_id)),
    #("fromOrgName", json.string(r.from_org_name)),
    #("toOrgIds", json.array(g.to, id.org_json)),
    #("resourceKind", grant_row.resource_kind_to_json(r.resource_kind)),
    #("resourceId", json.string(r.resource_id)),
    #("expiresAt", json.int(r.expires_at)),
    #("revokedAt", json.nullable(r.revoked_at, json.int)),
    #(
      "revokeReason",
      json.nullable(r.revoke_reason, grant_row.revoke_reason_to_json),
    ),
    #("createdBy", json.nullable(r.created_by_name, json.string)),
    #("createdAt", json.int(r.created_at)),
  ]
}

pub fn grant_json(g: Grant) -> Json {
  json.object(grant_fields(g))
}

// ------------------------------------------------------------------------------------------- what is shared

fn case_of(
  read: Read,
  case_id: String,
) -> Result(Option(case_row.Row), Fail(e)) {
  store.one(
    read,
    "SELECT " <> case_row.columns <> " FROM recruitment_cases WHERE id = ?",
    [id.recruitment_case_sql(id.recruitment_case(case_id))],
    case_row.decoder(),
  )
  |> result.map(option.from_result)
}

/// Does the organisation own this resource, so it may share it? A shortlist is shared whole (`*`), and an
/// assessment once it is out of draft.
pub fn owns(
  read: Read,
  kind: grant_row.ResourceKind,
  resource_id: String,
  org_id: id.OrgId,
) -> Result(Bool, Fail(e)) {
  case kind {
    grant_row.Shortlist -> Ok(resource_id == "*")
    grant_row.Case ->
      case_of(read, resource_id)
      |> result.map(fn(c) {
        case c {
          Some(c) -> c.org_id == org_id
          None -> False
        }
      })
    grant_row.Assessment ->
      assessments.by_id(read, id.assessment(resource_id))
      |> result.map(fn(a) {
        case a {
          Some(a) ->
            a.row.org_id == org_id && a.row.state != assessment_row.Draft
          None -> False
        }
      })
  }
}

/// The live gate: a player the organisation may see on its own, and not blocking it.
fn visible_to(
  read: Read,
  org: Org,
  player_ids: List(id.PlayerId),
  now: Int,
) -> Result(List(players.Player), Fail(e)) {
  players.for_org_many(read, player_ids, org, now)
  |> result.map(
    list.filter_map(_, fn(found) {
      case found.1.visible && !found.1.blocked {
        True -> Ok(found.0)
        False -> Error(Nil)
      }
    }),
  )
}

/// What `receiving` would see of `from_org_id`'s resource, through the same rules the shared read uses, so a
/// preview never promises more than the grant delivers.
pub fn resource_view(
  read: Read,
  from_org_id: id.OrgId,
  kind: grant_row.ResourceKind,
  resource_id: String,
  receiving: Org,
  now: Int,
) -> Result(Json, Fail(e)) {
  let kind_json = #("kind", grant_row.resource_kind_to_json(kind))
  case kind {
    grant_row.Shortlist -> {
      use ids <- result.try(ledger.shortlisted_by(read, from_org_id))
      use visible <- result.map(visible_to(read, receiving, ids, now))
      let withheld = list.length(ids) - list.length(visible)
      json.object([
        kind_json,
        #(
          "players",
          json.array(visible, fn(p) {
            json.object([
              #("id", id.player_json(p.row.id)),
              #("name", json.string(p.row.name)),
              #("position", json.nullable(p.row.position, position.to_json)),
              #("level", playing_level.to_json(p.row.level)),
            ])
          }),
        ),
        #("withheld", json.int(withheld)),
        #("withheldNote", case withheld > 0 {
          True ->
            json.string(
              int.to_string(withheld)
              <> " player(s) withheld — outside your organisation's own visibility rules (under-18 verification, agency wall, grassroots level/50 km). A group grant never overrides those.",
            )
          False -> json.null()
        }),
      ])
    }
    grant_row.Case -> {
      use found <- result.try(case_of(read, resource_id))
      case found {
        Some(c) if c.org_id == from_org_id -> {
          use seen <- result.map(visible_to(read, receiving, [c.player_id], now))
          case seen {
            [] ->
              json.object([
                kind_json,
                #(
                  "withheldNote",
                  json.string(
                    "The player in this case is not visible to your organisation under the standing rules.",
                  ),
                ),
              ])
            _ ->
              json.object([
                kind_json,
                #(
                  "case",
                  json.object([
                    #("id", id.recruitment_case_json(c.id)),
                    #("playerName", json.nullable(c.player_name, json.string)),
                    #("stage", case_row.stage_to_json(c.stage)),
                    #("priority", case_row.priority_to_json(c.priority)),
                    #("decision", case_workspace.decision_json(c)),
                  ]),
                ),
              ])
          }
        }
        _ -> Ok(json.object([kind_json, #("gone", json.bool(True))]))
      }
    }
    grant_row.Assessment -> {
      use found <- result.try(assessments.by_id(
        read,
        id.assessment(resource_id),
      ))
      case found {
        Some(a) if a.row.org_id == from_org_id -> {
          use seen <- result.map(visible_to(
            read,
            receiving,
            [a.row.player_id],
            now,
          ))
          case seen {
            [] ->
              json.object([
                kind_json,
                #(
                  "withheldNote",
                  json.string(
                    "The assessed player is not visible to your organisation under the standing rules.",
                  ),
                ),
              ])
            _ ->
              json.object([
                kind_json,
                #(
                  "assessment",
                  json.object([
                    #("id", id.assessment_json(a.row.id)),
                    #(
                      "playerName",
                      json.nullable(a.row.player_name, json.string),
                    ),
                    #("scoutName", json.string(a.row.scout_name)),
                    #("templateId", json.string(a.row.template_id)),
                    #("ratings", json.array(a.ratings, assessments.rating_json)),
                    #("recommendation", assessments.recommendation_json(a.row)),
                    #("context", assessments.context_json(a.row)),
                  ]),
                ),
              ])
          }
        }
        _ -> Ok(json.object([kind_json, #("gone", json.bool(True))]))
      }
    }
  }
}
