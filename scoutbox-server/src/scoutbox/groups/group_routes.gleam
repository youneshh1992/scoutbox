//// The routes of federation groups (domains/groups/groups.mjs): Trust & Safety onboards a group with an admin
//// organisation; the admin invites clubs, whose leads accept; members share resources by explicit, expiring grants.
////
//// Membership alone shares nothing. A grant's read checks every condition now: the reader is named, the grant is
//// live, the owner still shares a group with the reader, and each player is one the reader may see on its own.
//// Each act re-checks the group inside its unit, so a lost race answers from the state that won.

import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/groups/groups.{type Grant, type Group}
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/orgs.{type Org}
import scoutbox/identity/staff
import scoutbox/messaging/notifications
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/pages
import scoutbox/platform/paging
import scoutbox/platform/store.{type Fail, type Read, type Tx}
import scoutbox/rows/group_grant_recipients as recipient_row
import scoutbox/rows/group_grants as grant_row
import scoutbox/rows/group_members as member_row
import scoutbox/rows/group_pending_invites as invite_row
import scoutbox/rows/group_programmes as programme_row
import scoutbox/rows/group_shared_templates as template_row
import scoutbox/rows/groups as group_row
import scoutbox/rows/id
import scoutbox/rows/orgs as org_row
import scoutbox/scouting/assessments
import scoutbox/vocab/audience
import scoutbox/vocab/org_type
import sqlight
import wisp.{type Request, type Response}

const suppress_min = 3

fn agencies_excluded() -> Response {
  http.error_message(
    403,
    "AGENCIES_EXCLUDED",
    "Agency organisations cannot join club/federation workspaces.",
  )
}

fn admin_only() -> Response {
  http.error(403, "GROUP_ADMIN_ONLY")
}

fn not_a_member(status: Int) -> Response {
  http.error(status, "NOT_A_MEMBER")
}

fn group_limit(message: String) -> Response {
  http.error_message(409, "GROUP_LIMIT", message)
}

fn org_of(read: Read, org_id: id.OrgId) -> Result(Option(Org), Fail(e)) {
  orgs.by_id(read, org_id)
}

/// The group the organisation administers, or the 403 a non-admin gets (an unknown group included).
fn administered(
  read: Read,
  gid: id.GroupId,
  org_id: id.OrgId,
) -> Result(Group, Fail(Response)) {
  use found <- result.try(groups.by_id(read, gid))
  case found {
    Some(g) ->
      case groups.is_admin(g, org_id) {
        True -> Ok(g)
        False -> store.refuse(admin_only())
      }
    None -> store.refuse(admin_only())
  }
}

/// The group the organisation is a member of, or the refusal a non-member gets.
fn membership(
  read: Read,
  gid: id.GroupId,
  org_id: id.OrgId,
  refusal: Response,
) -> Result(Group, Fail(Response)) {
  use found <- result.try(groups.by_id(read, gid))
  case found {
    Some(g) ->
      case groups.is_member(g, org_id) {
        True -> Ok(g)
        False -> store.refuse(refusal)
      }
    None -> store.refuse(refusal)
  }
}

/// Runs `check` on a read before the body is read, so its refusal comes first, as in the TypeScript route.
fn first(
  ctx: Ctx,
  check: fn(Read) -> Result(a, Fail(Response)),
  next: fn() -> Response,
) -> Response {
  case store.read(ctx.store, check) {
    Ok(_) -> next()
    Error(store.Refuse(response)) -> response
    Error(failure) -> http.internal(failure)
  }
}

/// A unit's outcome as the response.
fn answer(
  outcome: Result(a, store.UnitError(Response)),
  status: Int,
  body: fn(a) -> Json,
) -> Response {
  case outcome {
    Ok(value) -> http.json(status, body(value))
    Error(store.Refused(response)) -> response
    Error(failure) -> http.internal(failure)
  }
}

/// A read's outcome as a 200.
fn answer_read(outcome: Result(Json, Fail(Response))) -> Response {
  case outcome {
    Ok(body) -> http.json(200, body)
    Error(store.Refuse(response)) -> response
    Error(failure) -> http.internal(failure)
  }
}

fn group_body(g: Group) -> Json {
  json.object([#("group", groups.view(g))])
}

fn read_back(read: Read, gid: id.GroupId) -> Result(Group, Fail(e)) {
  use found <- result.map(groups.by_id(read, gid))
  let assert Some(g) = found as "a group reads back in its unit"
  g
}

/// A notice to the organisation's first current staff member, when it has one.
fn tell_lead(
  tx: Tx,
  org_id: id.OrgId,
  text: String,
  ref_id: String,
  at: Int,
) -> Result(Nil, Fail(e)) {
  use lead <- result.try(staff.first_active(store.reading(tx), org_id))
  case lead {
    Some(u) ->
      notifications.notify(
        tx,
        to: audience.OrgUser,
        id: id.org_user_to_string(u.id),
        type_: "group",
        text:,
        ref_id: Some(ref_id),
        at:,
      )
    None -> Ok(Nil)
  }
}

// ----------------------------------------------------------------------------------------------- administration

type NewGroup {
  NewGroup(name: String, admin_org_id: String)
}

/// `POST /admin/groups`: a group with its admin organisation as its first member.
pub fn admin_create(ctx: Ctx, req: Request) -> Response {
  let shape = {
    use name <- input.field(
      "name",
      input.required(input.required_text(groups.name_max)),
    )
    use admin_org_id <- input.field("adminOrgId", input.required(input.id()))
    input.done(NewGroup(name:, admin_org_id:))
  }
  use body <- http.body(req, shape, [])
  let now = clock.now_ms()
  let made =
    store.unit(ctx.store, fn(tx) {
      let read = store.reading(tx)
      use admin <- result.try(org_of(read, id.org(body.admin_org_id)))
      case admin {
        None -> store.refuse(http.error(404, "ORG_NOT_FOUND"))
        Some(admin) if admin.type_ == org_type.Agency ->
          store.refuse(agencies_excluded())
        Some(admin) -> {
          use gid <- result.try(id.next_group(tx))
          use _ <- result.try(group_row.insert(
            tx,
            group_row.new(id: gid, name: body.name, created_at: now),
          ))
          use _ <- result.try(member_row.insert(
            tx,
            member_row.new(group_id: gid, org_id: admin.id, admin: True),
          ))
          read_back(read, gid)
        }
      }
    })
  answer(made, 201, group_body)
}

/// `GET /admin/groups`: every group, newest first by cursor.
pub fn admin_page(ctx: Ctx, req: Request) -> Response {
  use page <- pages.lenient(req, [paging.IntKind])
  case store.read(ctx.store, groups.page(_, page)) {
    Ok(#(items, next)) -> pages.respond(items, next, groups.view)
    Error(failure) -> http.internal(failure)
  }
}

// ------------------------------------------------------------------------------------------------ membership

/// `GET /org/groups`: the organisation's groups, each with its members, and the groups that invited it.
pub fn org_list(ctx: Ctx, a: OrgAccess) -> Response {
  let found =
    store.read(ctx.store, fn(read) {
      use mine <- result.try(groups.for_member(read, a.org.id))
      use items <- result.try(
        list.try_map(mine, fn(g) {
          use members <- result.map(
            list.try_map(groups.member_ids(g), org_of(read, _)),
          )
          json.object(
            list.append(groups.view_fields(g), [
              #(
                "members",
                json.array(option.values(members), fn(o) {
                  json.object([
                    #("id", id.org_json(o.id)),
                    #("name", json.string(o.name)),
                    #("level", case o.level {
                      Some(level) -> org_row.level_to_json(level)
                      None -> json.string("pro")
                    }),
                  ])
                }),
              ),
              #("youAdmin", json.bool(groups.is_admin(g, a.org.id))),
            ]),
          )
        }),
      )
      use invites <- result.map(groups.invites_for(read, a.org.id))
      json.object([
        #("items", json.preprocessed_array(items)),
        #(
          "invites",
          json.array(invites, fn(i) {
            json.object([
              #("groupId", id.group_json(i.0)),
              #("name", json.string(i.1)),
            ])
          }),
        ),
      ])
    })
  case found {
    Ok(body) -> http.json(200, body)
    Error(failure) -> http.internal(failure)
  }
}

/// `POST /org/groups/:id/invite`: the admin organisation invites another club; its lead hears and may accept.
pub fn invite(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  gid: id.GroupId,
) -> Response {
  use <- access.require_lead(a)
  use <- first(ctx, administered(_, gid, a.org.id))
  let shape = {
    use org_id <- input.field("orgId", input.required(input.id()))
    input.done(org_id)
  }
  use target_id <- http.body(req, shape, [])
  let now = clock.now_ms()
  let invited =
    store.unit(ctx.store, fn(tx) {
      let read = store.reading(tx)
      use g <- result.try(administered(read, gid, a.org.id))
      use target <- result.try(org_of(read, id.org(target_id)))
      case target {
        None -> store.refuse(http.error(404, "ORG_NOT_FOUND"))
        Some(target) if target.type_ == org_type.Agency ->
          store.refuse(agencies_excluded())
        Some(target) ->
          case
            groups.is_member(g, target.id) || groups.is_invited(g, target.id),
            list.length(g.members) + list.length(g.invites)
            >= groups.members_max
          {
            True, _ -> store.refuse(http.error(409, "ALREADY_INVITED"))
            _, True ->
              store.refuse(group_limit(
                "A group holds at most "
                <> int.to_string(groups.members_max)
                <> " members and invites.",
              ))
            False, False -> {
              use _ <- result.try(invite_row.insert(
                tx,
                invite_row.new(
                  group_id: gid,
                  org_id: target.id,
                  invited_by_org_id: a.org.id,
                  invited_at: now,
                ),
              ))
              use _ <- result.try(tell_lead(
                tx,
                target.id,
                "🤝 "
                  <> a.org.name
                  <> " invited "
                  <> target.name
                  <> " to the “"
                  <> g.row.name
                  <> "” workspace. A lead can accept from Group settings. Joining shares NOTHING by itself.",
                id.group_to_string(gid),
                now,
              ))
              read_back(read, gid)
            }
          }
      }
    })
  answer(invited, 201, group_body)
}

/// `POST /org/groups/:id/accept`: the invited organisation joins, not as an admin.
pub fn accept(ctx: Ctx, a: OrgAccess, gid: id.GroupId) -> Response {
  use <- access.require_lead(a)
  let accepted =
    store.unit(ctx.store, fn(tx) {
      use removed <- result.try(store.write(
        tx,
        "DELETE FROM group_pending_invites WHERE group_id = ? AND org_id = ? RETURNING org_id",
        [id.group_sql(gid), id.org_sql(a.org.id)],
        decode.at([0], id.org_decoder()),
      ))
      case removed {
        [] -> store.refuse(http.error(404, "NO_INVITE"))
        _ -> {
          use _ <- result.try(member_row.insert(
            tx,
            member_row.new(group_id: gid, org_id: a.org.id, admin: False),
          ))
          read_back(store.reading(tx), gid)
        }
      }
    })
  answer(accepted, 200, fn(g) {
    json.object([
      #("group", groups.view(g)),
      #(
        "note",
        json.string(
          "You are a member. Access to anything remains grant-by-grant: default isolated.",
        ),
      ),
    ])
  })
}

/// `POST /org/groups/:id/leave`: the organisation leaves, and every grant it gives or receives whose owner no
/// longer shares a group with any of its recipients ends in the same unit. A grant whose other recipients still
/// share a group stays live for them.
pub fn leave(ctx: Ctx, a: OrgAccess, gid: id.GroupId) -> Response {
  use <- access.require_lead(a)
  let now = clock.now_ms()
  let left =
    store.unit(ctx.store, fn(tx) {
      use removed <- result.try(store.write(
        tx,
        "DELETE FROM group_members WHERE group_id = ? AND org_id = ? RETURNING org_id",
        [id.group_sql(gid), id.org_sql(a.org.id)],
        decode.at([0], id.org_decoder()),
      ))
      case removed {
        [] -> store.refuse(not_a_member(404))
        _ ->
          store.write(
            tx,
            "UPDATE group_grants AS gr SET revoked_at = ?, revoke_reason = 'group_departure'
            WHERE gr.revoked_at IS NULL
              AND (gr.from_org_id = ? OR EXISTS (SELECT 1 FROM group_grant_recipients r WHERE r.grant_id = gr.id AND r.org_id = ?))
              AND NOT EXISTS (
                SELECT 1 FROM group_grant_recipients r
                JOIN group_members a ON a.org_id = gr.from_org_id
                JOIN group_members b ON b.group_id = a.group_id AND b.org_id = r.org_id
                WHERE r.grant_id = gr.id)
            RETURNING id",
            [sqlight.int(now), id.org_sql(a.org.id), id.org_sql(a.org.id)],
            decode.at([0], id.group_grant_decoder()),
          )
          |> result.map(list.length)
      }
    })
  answer(left, 200, fn(ended) {
    json.object([
      #("left", json.bool(True)),
      #("grantsEnded", json.int(ended)),
      #(
        "note",
        json.string(
          "Your records stay yours — leaving removes group access in both directions, never ownership.",
        ),
      ),
    ])
  })
}

/// `POST /org/groups/:id/templates`: the admin shares one of the assessment templates with the group (once).
pub fn share_template(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  gid: id.GroupId,
) -> Response {
  use <- access.require_lead(a)
  use <- first(ctx, administered(_, gid, a.org.id))
  let shape = {
    use template_id <- input.field("templateId", input.required(input.id()))
    input.done(template_id)
  }
  use template_id <- http.body(req, shape, [])
  let shared =
    store.unit(ctx.store, fn(tx) {
      let read = store.reading(tx)
      use g <- result.try(administered(read, gid, a.org.id))
      use t <- result.try(assessments.current_template_by_id(read, template_id))
      case t {
        None -> store.refuse(http.error(404, "TEMPLATE_NOT_FOUND"))
        Some(t) ->
          case list.contains(g.templates, t.id) {
            True -> Ok(g)
            False ->
              case list.length(g.templates) >= groups.templates_max {
                True ->
                  store.refuse(group_limit(
                    "A group shares at most "
                    <> int.to_string(groups.templates_max)
                    <> " templates.",
                  ))
                False -> {
                  use _ <- result.try(template_row.insert(
                    tx,
                    template_row.new(group_id: gid, template_id: t.id),
                  ))
                  read_back(read, gid)
                }
              }
          }
      }
    })
  answer(shared, 200, group_body)
}

type NewProgramme {
  NewProgramme(name: Option(String), region: Option(String))
}

/// `POST /org/groups/:id/programmes`: the admin adds a programme; a blank region is none.
pub fn add_programme(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  gid: id.GroupId,
) -> Response {
  use <- access.require_lead(a)
  use <- first(ctx, administered(_, gid, a.org.id))
  let shape = {
    use name <- input.field(
      "name",
      input.nullish(input.required_text(groups.programme_name_max)),
    )
    use region <- input.field(
      "region",
      input.nullish(input.text(groups.region_max)),
    )
    input.done(NewProgramme(name:, region:))
  }
  use body <- http.body(req, shape, [])
  let now = clock.now_ms()
  let added =
    store.unit(ctx.store, fn(tx) {
      let read = store.reading(tx)
      use g <- result.try(administered(read, gid, a.org.id))
      case list.length(g.programmes) >= groups.programmes_max {
        True ->
          store.refuse(group_limit(
            "A group holds at most "
            <> int.to_string(groups.programmes_max)
            <> " programmes.",
          ))
        False -> {
          use pid <- result.try(id.next_programme(tx))
          use _ <- result.try(programme_row.insert(
            tx,
            programme_row.Row(
              ..programme_row.new(
                id: pid,
                group_id: gid,
                name: option.unwrap(body.name, "Programme"),
                created_at: now,
              ),
              region: case body.region {
                Some(r) ->
                  case string.trim(r) {
                    "" -> None
                    _ -> Some(r)
                  }
                None -> None
              },
            ),
          ))
          read_back(read, gid)
        }
      }
    })
  answer(added, 201, group_body)
}

/// `GET /org/groups/:id/report`: the admin's view of the group's activity. Counts under 3 are suppressed and no
/// player appears.
pub fn report(ctx: Ctx, a: OrgAccess, gid: id.GroupId) -> Response {
  use <- access.require_lead(a)
  let now = clock.now_ms()
  let found =
    store.read(ctx.store, fn(read) {
      use g <- result.try(administered(read, gid, a.org.id))
      use rows <- result.try(
        list.try_map(groups.member_ids(g), fn(org_id) {
          use org <- result.try(org_of(read, org_id))
          use assessed <- result.try(count(
            read,
            "SELECT COUNT(*) FROM assessments WHERE org_id = ? AND state <> 'draft'",
            org_id,
          ))
          use signed <- result.map(count(
            read,
            "SELECT COUNT(*) FROM signings WHERE org_id = ?",
            org_id,
          ))
          json.object([
            #("orgId", id.org_json(org_id)),
            #(
              "orgName",
              json.nullable(option.map(org, fn(o) { o.name }), json.string),
            ),
            #("assessments", suppressed(assessed)),
            #("signings", suppressed(signed)),
          ])
        }),
      )
      use #(created, live) <- result.map(groups.counts_for_group(read, gid, now))
      json.object([
        #(
          "group",
          json.object([
            #("id", id.group_json(g.row.id)),
            #("name", json.string(g.row.name)),
            #("members", json.int(list.length(g.members))),
          ]),
        ),
        #("activity", json.preprocessed_array(rows)),
        #(
          "sharing",
          json.object([
            #("grantsCreated", json.int(created)),
            #("live", json.int(live)),
          ]),
        ),
        #(
          "note",
          json.string(
            "Counts under 3 are suppressed. This report contains NO player-level data — player records stay inside each member club's own permissions.",
          ),
        ),
      ])
    })
  answer_read(found)
}

fn count(read: Read, sql: String, org_id: id.OrgId) -> Result(Int, Fail(e)) {
  store.one(read, sql, [id.org_sql(org_id)], decode.at([0], decode.int))
  |> result.map(result.unwrap(_, 0))
}

fn suppressed(n: Int) -> Json {
  case n < suppress_min {
    True -> json.string("<3")
    False -> json.int(n)
  }
}

// ------------------------------------------------------------------------------------------------------ grants

type GrantInput {
  GrantInput(
    resource_kind: grant_row.ResourceKind,
    resource_id: String,
    to_org_ids: List(String),
    expires_days: Option(Int),
  )
}

fn grant_shape(with_expiry: Bool) -> input.Shape(GrantInput) {
  use resource_kind <- input.field(
    "resourceKind",
    input.required(input.one_of(grant_row.resource_kind_pairs)),
  )
  use resource_id <- input.field("resourceId", input.required(input.id()))
  use to_org_ids <- input.field(
    "toOrgIds",
    input.nullish(input.items(input.id(), groups.members_max)),
  )
  let to_org_ids = option.unwrap(to_org_ids, [])
  case with_expiry {
    False ->
      input.done(GrantInput(
        resource_kind:,
        resource_id:,
        to_org_ids:,
        expires_days: None,
      ))
    True -> {
      use expires_days <- input.field(
        "expiresDays",
        input.nullish(input.whole_number(
          groups.expires_days_min,
          groups.expires_days_max,
        )),
      )
      input.done(GrantInput(
        resource_kind:,
        resource_id:,
        to_org_ids:,
        expires_days:,
      ))
    }
  }
}

fn resource_invalid() -> Response {
  http.error_message(
    400,
    "RESOURCE_INVALID",
    "You can only share resources your organisation owns.",
  )
}

/// The named members other than the sharer, once each, in the order named.
fn recipients_of(
  g: Group,
  to: List(String),
  sharer: id.OrgId,
) -> List(id.OrgId) {
  to
  |> list.unique
  |> list.map(id.org)
  |> list.filter(fn(o) { groups.is_member(g, o) && o != sharer })
}

/// The group the organisation is a member of, and that it owns the resource: the checks a preview and a grant
/// share.
fn sharer_checks(
  read: Read,
  gid: id.GroupId,
  a: OrgAccess,
  body: GrantInput,
) -> Result(Group, Fail(Response)) {
  use g <- result.try(membership(read, gid, a.org.id, not_a_member(403)))
  use owned <- result.try(groups.owns(
    read,
    body.resource_kind,
    body.resource_id,
    a.org.id,
  ))
  case owned {
    True -> Ok(g)
    False -> store.refuse(resource_invalid())
  }
}

/// `POST /org/groups/:id/grants/preview`: what each named member would see, through the rules the real read uses.
pub fn preview(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  gid: id.GroupId,
) -> Response {
  use <- access.require_lead(a)
  use <- first(ctx, membership(_, gid, a.org.id, not_a_member(403)))
  use body <- http.body(req, grant_shape(False), [])
  let now = clock.now_ms()
  let found =
    store.read(ctx.store, fn(read) {
      use g <- result.try(sharer_checks(read, gid, a, body))
      use recipients <- result.map(
        list.try_map(recipients_of(g, body.to_org_ids, a.org.id), fn(org_id) {
          use org <- result.try(org_of(read, org_id))
          let assert Some(org) = org as "a member organisation exists"
          use seen <- result.map(groups.resource_view(
            read,
            a.org.id,
            body.resource_kind,
            body.resource_id,
            org,
            now,
          ))
          json.object([
            #("orgId", id.org_json(org_id)),
            #("orgName", json.string(org.name)),
            #("wouldSee", seen),
          ])
        }),
      )
      json.object([
        #("recipients", json.preprocessed_array(recipients)),
        #(
          "note",
          json.string(
            "Per-recipient preview through the same rules the real read uses.",
          ),
        ),
      ])
    })
  answer_read(found)
}

/// `POST /org/groups/:id/grants`: share a resource with named fellow members (never an agency) for `expiresDays`
/// (30 when not given); each recipient's lead hears.
pub fn create_grant(
  ctx: Ctx,
  req: Request,
  a: OrgAccess,
  gid: id.GroupId,
) -> Response {
  use <- access.require_lead(a)
  use <- first(ctx, membership(_, gid, a.org.id, not_a_member(403)))
  use body <- http.body(req, grant_shape(True), [])
  let now = clock.now_ms()
  let made =
    store.unit(ctx.store, fn(tx) {
      let read = store.reading(tx)
      use g <- result.try(sharer_checks(read, gid, a, body))
      use named <- result.try(
        list.try_map(recipients_of(g, body.to_org_ids, a.org.id), fn(org_id) {
          org_of(read, org_id)
        }),
      )
      let recipients =
        named
        |> option.values
        |> list.filter(fn(o) { o.type_ != org_type.Agency })
      case recipients {
        [] ->
          store.refuse(http.error_message(
            400,
            "RECIPIENTS_REQUIRED",
            "Name at least one other member organisation.",
          ))
        _ -> {
          use grant_id <- result.try(id.next_group_grant(tx))
          let days = option.unwrap(body.expires_days, groups.default_days)
          use _ <- result.try(grant_row.insert(
            tx,
            grant_row.Row(
              ..grant_row.new(
                id: grant_id,
                group_id: gid,
                from_org_id: a.org.id,
                from_org_name: a.org.name,
                resource_kind: body.resource_kind,
                resource_id: body.resource_id,
                expires_at: now + days * groups.day_ms,
                created_at: now,
              ),
              created_by_name: Some(a.user.name),
            ),
          ))
          use _ <- result.try(
            list.index_map(recipients, fn(o, ord) { #(o, ord) })
            |> list.try_each(fn(p) {
              recipient_row.insert(
                tx,
                recipient_row.new(grant_id:, ord: p.1, org_id: { p.0 }.id),
              )
            }),
          )
          use _ <- result.try(
            list.try_each(recipients, fn(o) {
              tell_lead(
                tx,
                o.id,
                "📂 "
                  <> a.org.name
                  <> " shared a "
                  <> grant_row.resource_kind_to_string(body.resource_kind)
                  <> " with your club in “"
                  <> g.row.name
                  <> "”.",
                id.group_grant_to_string(grant_id),
                now,
              )
            }),
          )
          use found <- result.map(groups.grant_by_id(read, grant_id))
          let assert Some(grant) = found as "a grant reads back in its unit"
          grant
        }
      }
    })
  answer(made, 201, fn(grant) {
    json.object([#("grant", groups.grant_json(grant))])
  })
}

/// `GET /org/grants`: the grants the organisation gave, newest first by cursor, and the ones it can read now.
pub fn grants(ctx: Ctx, req: Request, a: OrgAccess) -> Response {
  use page <- pages.lenient(req, [paging.IntKind])
  let now = clock.now_ms()
  let found =
    store.read(ctx.store, fn(read) {
      use #(given, next) <- result.try(groups.page_given(read, a.org.id, page))
      use received <- result.map(groups.live_received(read, a.org.id, now))
      json.object([
        #(
          "given",
          json.array(given, fn(g) {
            json.object(
              list.append(groups.grant_fields(g), [
                #("live", json.bool(groups.is_live(g, now))),
              ]),
            )
          }),
        ),
        #("nextCursor", json.nullable(next, json.string)),
        #(
          "received",
          json.array(received, fn(g: Grant) {
            json.object([
              #("id", id.group_grant_json(g.row.id)),
              #("fromOrgName", json.string(g.row.from_org_name)),
              #(
                "resourceKind",
                grant_row.resource_kind_to_json(g.row.resource_kind),
              ),
              #("expiresAt", json.int(g.row.expires_at)),
            ])
          }),
        ),
      ])
    })
  case found {
    Ok(body) -> http.json(200, body)
    Error(failure) -> http.internal(failure)
  }
}

/// `GET /org/grants/counts`.
pub fn grant_counts(ctx: Ctx, a: OrgAccess) -> Response {
  case store.read(ctx.store, groups.counts_for(_, a.org.id, clock.now_ms())) {
    Ok(#(given, received)) ->
      http.json(
        200,
        json.object([
          #("given", json.int(given)),
          #("received", json.int(received)),
        ]),
      )
    Error(failure) -> http.internal(failure)
  }
}

/// `POST /org/grants/:id/revoke`: the owner ends a grant; the first revocation stands.
pub fn revoke(ctx: Ctx, a: OrgAccess, grant_id: id.GroupGrantId) -> Response {
  use <- access.require_lead(a)
  let now = clock.now_ms()
  let revoked =
    store.unit(ctx.store, fn(tx) {
      let read = store.reading(tx)
      use found <- result.try(groups.grant_by_id(read, grant_id))
      case found {
        Some(g) if g.row.from_org_id == a.org.id -> {
          use _ <- result.try(
            store.run(
              tx,
              "UPDATE group_grants SET revoked_at = ?, revoke_reason = 'revoked_by_owner' WHERE id = ? AND revoked_at IS NULL",
              [sqlight.int(now), id.group_grant_sql(grant_id)],
            ),
          )
          use found <- result.map(groups.grant_by_id(read, grant_id))
          let assert Some(g) = found as "the grant reads back in its unit"
          g
        }
        _ -> store.refuse(http.error(404, "GRANT_NOT_FOUND"))
      }
    })
  answer(revoked, 200, fn(g) {
    json.object([
      #("grant", groups.grant_json(g)),
      #(
        "note",
        json.string(
          "Effective immediately: the shared read, media entitlements and event delivery all re-check the grant live.",
        ),
      ),
    ])
  })
}

/// `GET /org/shared/:grantId`: a recipient reads what it was granted, every condition evaluated now.
pub fn shared(ctx: Ctx, a: OrgAccess, grant_id: id.GroupGrantId) -> Response {
  let now = clock.now_ms()
  let found =
    store.read(ctx.store, fn(read) {
      use found <- result.try(groups.grant_by_id(read, grant_id))
      case found {
        Some(g) ->
          case list.contains(g.to, a.org.id), groups.is_live(g, now) {
            False, _ -> store.refuse(http.error(404, "GRANT_NOT_FOUND"))
            True, False ->
              store.refuse(http.error_message(
                403,
                "GRANT_ENDED",
                "This share was revoked or expired.",
              ))
            True, True -> {
              use together <- result.try(groups.share_a_group(
                read,
                g.row.from_org_id,
                a.org.id,
              ))
              case together {
                False ->
                  store.refuse(http.error_message(
                    403,
                    "GROUP_MEMBERSHIP_ENDED",
                    "One of the organisations left the shared workspace.",
                  ))
                True -> {
                  use resource <- result.map(groups.resource_view(
                    read,
                    g.row.from_org_id,
                    g.row.resource_kind,
                    g.row.resource_id,
                    a.org,
                    now,
                  ))
                  json.object([
                    #("grantId", id.group_grant_json(g.row.id)),
                    #("from", json.string(g.row.from_org_name)),
                    #("resource", resource),
                  ])
                }
              }
            }
          }
        None -> store.refuse(http.error(404, "GRANT_NOT_FOUND"))
      }
    })
  answer_read(found)
}
