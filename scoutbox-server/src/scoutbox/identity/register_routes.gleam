//// `POST /auth/org/register-grassroots`: a grassroots club registers itself, its first administrator and a session.
//// Trust & Safety verifies the club (federation record, e-mail domain, safeguarding contract) before it sees any
//// minor.

import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import scoutbox/app.{type Ctx}
import scoutbox/identity/orgs
import scoutbox/identity/passwords
import scoutbox/identity/sessions
import scoutbox/identity/staff
import scoutbox/platform/clock
import scoutbox/platform/http
import scoutbox/platform/input
import scoutbox/platform/live_event
import scoutbox/platform/live_pings
import scoutbox/platform/store
import scoutbox/rows/id
import scoutbox/rows/orgs as org_row
import scoutbox/vocab/org_type
import wisp.{type Request, type Response}

const password_min = 8

const password_max = 256

type Registration {
  Registration(
    name: Option(String),
    country: Option(String),
    city: Option(String),
    lat: Option(Float),
    lng: Option(Float),
    federation: Option(String),
    registration_id: Option(String),
    scout_name: Option(String),
    role: Option(String),
    password: Option(String),
  )
}

fn shape() -> input.Shape(Registration) {
  use name <- input.field("name", input.nullish(input.text(120)))
  // One or two characters; the route judges the rest.
  use country <- input.field("country", input.optional(input.id_of(2)))
  use city <- input.field("city", input.nullish(input.text(80)))
  use lat <- input.field("lat", input.nullish(input.number(-90, 90)))
  use lng <- input.field("lng", input.nullish(input.number(-180, 180)))
  use federation <- input.field("federation", input.nullish(input.text(120)))
  use registration_id <- input.field(
    "registrationId",
    input.nullish(input.text(60)),
  )
  use scout_name <- input.field(
    "scoutName",
    input.nullish(input.text(staff.name_max)),
  )
  use role <- input.field("role", input.nullish(input.text(staff.role_max)))
  use password <- input.field(
    "password",
    input.nullish(input.text(password_max)),
  )
  input.done(Registration(
    name:,
    country:,
    city:,
    lat:,
    lng:,
    federation:,
    registration_id:,
    scout_name:,
    role:,
    password:,
  ))
}

pub fn register(ctx: Ctx, req: Request) -> Response {
  use body <- http.body(req, shape(), [])
  let country = option.unwrap(body.country, "GB")
  let name = input.filled(body.name)
  let federation = input.filled(body.federation)
  let registration_id = input.filled(body.registration_id)
  let scout_name = input.filled(body.scout_name)
  case body.password {
    Some(p) ->
      case input.utf16_length(p) < password_min {
        True ->
          http.error_message(
            400,
            "PASSWORD_TOO_SHORT",
            "Club passwords need at least 8 characters.",
          )
        False ->
          checked(
            ctx,
            body,
            country,
            name,
            federation,
            registration_id,
            scout_name,
          )
      }
    None ->
      checked(ctx, body, country, name, federation, registration_id, scout_name)
  }
}

fn checked(
  ctx: Ctx,
  body: Registration,
  country: String,
  name: Option(String),
  federation: Option(String),
  registration_id: Option(String),
  scout_name: Option(String),
) -> Response {
  let country_ok = country != "" && country == string.trim(country)
  case name, federation, registration_id, body.lat, body.lng, scout_name {
    None, _, _, _, _, _ -> http.error(400, "NAME_REQUIRED")
    _, _, _, _, _, _ if !country_ok ->
      http.json(
        400,
        json.object([
          #("error", json.string("FIELD_INVALID")),
          #("field", json.string("country")),
          #("problem", json.string("invalid")),
          #("message", json.string("country must be a country code.")),
        ]),
      )
    _, None, _, _, _, _ | _, _, None, _, _, _ ->
      http.error_message(
        400,
        "FEDERATION_REQUIRED",
        "Grassroots clubs must hold a federation registration — name the federation and your registration id.",
      )
    _, _, _, None, _, _ | _, _, _, _, None, _ ->
      http.error_message(
        400,
        "LOCATION_REQUIRED",
        "The 50km scouting radius is measured from your ground — a location is required.",
      )
    _, _, _, _, _, None -> http.error(400, "SCOUT_NAME_REQUIRED")
    Some(name),
      Some(federation),
      Some(registration_id),
      Some(lat),
      Some(lng),
      Some(scout_name)
    -> {
      // Before the unit: a hash takes about half a second, and the unit holds the only writer.
      let password_hash = case body.password {
        Some(p) -> Some(passwords.hash(p))
        None -> None
      }
      let now = clock.now_ms()
      let created =
        store.unit(ctx.store, fn(tx) {
          use org_id <- result.try(id.next_org(tx))
          use _ <- result.try(org_row.insert(
            tx,
            org_row.Row(
              ..org_row.new(
                id: org_id,
                name:,
                type_: org_type.Club,
                plan: org_row.PlanGrassroots,
                created_at: now,
              ),
              level: Some(org_row.LevelGrassroots),
              country: Some(country),
              city: input.filled(body.city),
              lat: Some(lat),
              lng: Some(lng),
              federation: Some(federation),
              federation_registration_id: Some(registration_id),
              password_hash:,
            ),
          ))
          use found <- result.try(orgs.by_id(store.reading(tx), org_id))
          let assert Some(org) = found
            as "an organisation just registered exists"
          use admin <- result.try(staff.create(
            tx,
            staff.NewStaff(
              org_id:,
              name: scout_name,
              role: option.unwrap(input.filled(body.role), "Manager"),
              email: None,
              provenance: None,
              created_at: now,
            ),
          ))
          use token <- result.try(sessions.create(
            tx,
            sessions.OrgStaff(org_id, admin.id),
            now,
            ctx.config.session_ttl_ms,
          ))
          use certified <- result.map(orgs.safeguarding_certified(
            store.reading(tx),
            org,
          ))
          live_pings.catalogue(tx, live_event.Orgs)
          #(org, admin, token, certified)
        })
      case created {
        Error(failure) -> http.internal(failure)
        Ok(#(org, admin, token, certified)) ->
          http.json(
            201,
            json.object([
              #("userId", id.org_user_json(admin.id)),
              #("role", json.string(admin.role)),
              #(
                "org",
                json.object(
                  // A club just registered has set nothing up.
                  list.append(orgs.view(org, orgs.no_setup), [
                    #("safeguardingCertified", json.bool(certified)),
                  ]),
                ),
              ),
              #("token", json.string(token)),
              #(
                "note",
                json.string(
                  "Registered. Adults within 50km are visible now; under-18 visibility needs verification + the safeguarding contract, reviewed by Trust & Safety.",
                ),
              ),
            ]),
          )
      }
    }
  }
}
