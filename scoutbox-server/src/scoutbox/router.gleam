//// Every route the server answers, and the middleware in front of them.

import exception
import gleam/http.{Delete, Get, Patch, Post, Put}
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/result
import scoutbox/agents/core_routes as agent
import scoutbox/agents/handoffs
import scoutbox/agents/transaction_routes
import scoutbox/app.{type Ctx}
import scoutbox/development/box_prefs
import scoutbox/development/combine
import scoutbox/development/grassroots_club
import scoutbox/development/record_routes as record
import scoutbox/discovery/directory
import scoutbox/discovery/insights
import scoutbox/discovery/org_feed
import scoutbox/discovery/player_routes as discovery
import scoutbox/discovery/saved_searches
import scoutbox/enterprise/audit_export
import scoutbox/enterprise/org_audit
import scoutbox/enterprise/support
import scoutbox/identity/access.{type OrgAccess}
import scoutbox/identity/club_directory
import scoutbox/identity/erasure
import scoutbox/identity/guardian_routes
import scoutbox/identity/invite_routes
import scoutbox/identity/mfa_routes
import scoutbox/identity/orgs
import scoutbox/identity/player_routes
import scoutbox/identity/players
import scoutbox/identity/register_routes
import scoutbox/identity/sessions
import scoutbox/identity/sign_in
import scoutbox/identity/staff_routes
import scoutbox/insight/evidence_gaps
import scoutbox/insight/review_queue
import scoutbox/integrations/webhooks
import scoutbox/media/links
import scoutbox/messaging/channel_routes as threads
import scoutbox/messaging/delivery
import scoutbox/messaging/delivery_prefs
import scoutbox/messaging/feed_routes
import scoutbox/messaging/live_routes
import scoutbox/messaging/notification_prefs
import scoutbox/passport/football_passport
import scoutbox/passport/trust
import scoutbox/platform/clock
import scoutbox/platform/fault_routes
import scoutbox/platform/faults
import scoutbox/platform/http as contract
import scoutbox/platform/limits
import scoutbox/platform/operator
import scoutbox/platform/store
import scoutbox/platform/wisp_ewe
import scoutbox/recruitment/analytics
import scoutbox/recruitment/case_routes
import scoutbox/recruitment/contact_routes
import scoutbox/recruitment/lifecycle
import scoutbox/recruitment/offer_routes
import scoutbox/recruitment/request_routes
import scoutbox/recruitment/room_routes
import scoutbox/recruitment/signings
import scoutbox/recruitment/trial_day
import scoutbox/recruitment/trial_routes
import scoutbox/rows/id
import scoutbox/rows/ledger as ledger_row
import scoutbox/rows/ver_claims as claim_row
import scoutbox/safety/admin
import scoutbox/safety/console_routes as console
import scoutbox/safety/report_routes
import scoutbox/scouting/assessments
import scoutbox/scouting/board_routes
import scoutbox/scouting/evidence
import scoutbox/verification/applications
import scoutbox/verification/club_checks
import scoutbox/verification/console_routes as verification_console
import scoutbox/verification/invite_routes as invites
import scoutbox/verification/org_admin_routes as org_admin
import scoutbox/verification/personal_routes as personal
import scoutbox/verification/reference_routes as references
import scoutbox/verification/review_routes as review
import scoutbox/verification/transitions
import scoutbox/vocab/audience
import wisp.{type Request, type Response}

pub fn handle(ctx: Ctx, req: Request) -> Response {
  use <- baseline(ctx)
  use <- signed_media(ctx, req)
  use <- rescue
  use <- fault(ctx, req)
  case wisp.path_segments(req) {
    ["__faults"] ->
      case faults.enabled(ctx.faults) {
        True -> fault_routes.handle(ctx, req)
        False -> not_found()
      }
    ["health"] -> only(req, Get, fn() { health(ctx) })
    ["healthz"] -> only(req, Get, fn() { healthz(ctx) })
    ["meta"] -> only(req, Get, operator.meta)
    ["capabilities"] -> only(req, Get, fn() { operator.capabilities(ctx) })
    ["orgs"] -> only(req, Get, fn() { sign_in.org_list(ctx, req) })
    ["orgs", "directory"] ->
      only(req, Get, fn() { club_directory.directory(ctx, req) })
    ["media", id] -> only(req, Get, fn() { links.serve(ctx, req, id) })
    ["events"] -> only(req, Get, fn() { live_routes.connect(ctx, req) })
    ["events", "ticket"] ->
      only(req, Post, fn() { live_routes.ticket(ctx, req) })
    ["push", "register"] ->
      only(req, Post, fn() { feed_routes.register_device(ctx, req) })
    ["callbacks", "delivery"] ->
      only(req, Post, fn() { delivery.callback(ctx, req) })
    // Before the /auth limiter, so a sign-out is never limited.
    ["auth", "logout"] -> only(req, Post, fn() { logout(ctx, req) })
    ["auth", ..rest] -> {
      use <- auth_limit(ctx, req)
      case rest {
        ["org", "login"] -> only(req, Post, fn() { sign_in.login(ctx, req) })
        ["org", "register-grassroots"] ->
          only(req, Post, fn() { register_routes.register(ctx, req) })
        ["org", "accept-invite"] ->
          only(req, Post, fn() { invite_routes.accept(ctx, req) })
        ["org", "verification", "apply"] ->
          only(req, Post, fn() { applications.apply(ctx, req) })
        ["org", "verification", "apply", id, "confirm-email"] ->
          only(req, Post, fn() { applications.confirm_email(ctx, req, id) })
        ["org", "verification", "apply", id, "evidence"] ->
          only(req, Post, fn() { applications.evidence(ctx, req, id) })
        ["org", "verification", "apply", id, "submit"] ->
          only(req, Post, fn() { applications.submit(ctx, req, id) })
        ["org", "verification", "apply", id, "status"] ->
          only(req, Get, fn() { applications.status(ctx, req, id) })
        ["player", "login"] ->
          only(req, Post, fn() { player_routes.login(ctx, req) })
        ["player", "signup"] ->
          only(req, Post, fn() { player_routes.signup(ctx, req) })
        ["guardian", "signup"] ->
          only(req, Post, fn() { guardian_routes.signup(ctx, req) })
        ["guardian", "login"] ->
          only(req, Post, fn() { guardian_routes.login(ctx, req) })
        ["sso", "start"] -> only(req, Post, fn() { sso(ctx) })
        ["sso", "callback"] -> only(req, Post, fn() { sso(ctx) })
        _ -> not_found()
      }
    }
    // Every /org path needs a staff session, a path the server does not have included.
    ["org", ..rest] -> {
      use org <- access.org_session(ctx, req)
      case rest {
        ["verification", ..path] -> verification_org(ctx, req, org, path)
        ["rooms", ..path] -> rooms(ctx, req, org, path)
        ["agent", ..path] -> agent_org(ctx, req, org, path)
        ["offers", oid] ->
          only(req, Get, fn() { offer_routes.get(ctx, req, org, oid) })
        ["offers", oid, "history"] ->
          only(req, Get, fn() { offer_routes.history(ctx, req, org, oid) })
        ["offers", oid, "draft"] ->
          only(req, Patch, fn() {
            use req <- contract.rerun_on_stale(req)
            offer_routes.edit_draft(ctx, req, org, oid)
          })
        ["offers", oid, "issue"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            offer_routes.issue(ctx, req, org, oid)
          })
        ["offers", oid, "withdraw"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            offer_routes.withdraw(ctx, req, org, oid)
          })
        ["offers", oid, "revise"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            offer_routes.revise(ctx, req, org, oid)
          })
        ["recruitment", "offer-policy"] -> only(req, Get, offer_routes.policy)
        ["recruitment", "trial-policy"] -> only(req, Get, trial_routes.policy)
        ["recruitment", "contact-policy"] ->
          only(req, Get, contact_routes.policy)
        ["rooms-funnel"] ->
          only(req, Get, fn() { room_routes.funnel(ctx, org) })
        ["feed"] -> only(req, Get, fn() { org_feed.feed(ctx, org) })
        ["recruitment-analytics"] ->
          only(req, Get, fn() { analytics.dashboard(ctx, org) })
        ["requests"] ->
          only(req, Get, fn() { request_routes.org_page(ctx, req, org) })
        ["trials"] -> only(req, Get, fn() { trial_day.org_page(ctx, req, org) })
        ["trials", tid, "day"] ->
          only(req, Get, fn() { trial_day.day(ctx, org, tid) })
        ["trials", tid, "ics"] ->
          only(req, Get, fn() { trial_day.ics(ctx, org, tid) })
        ["trials", tid, "staff"] ->
          only(req, Post, fn() { trial_day.add_staff(ctx, req, org, tid) })
        ["trials", tid, "arrival"] ->
          only(req, Post, fn() { trial_day.set_arrival(ctx, req, org, tid) })
        ["trials", tid, "cancel"] ->
          only(req, Post, fn() {
            trial_day.day_status(ctx, req, org, tid, False)
          })
        ["trials", tid, "postpone"] ->
          only(req, Post, fn() {
            trial_day.day_status(ctx, req, org, tid, True)
          })
        ["trials", tid, "checkin"] ->
          only(req, Post, fn() { trial_day.check_in(ctx, org, tid) })
        ["trials", tid, "report"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            trial_day.report(ctx, req, org, tid)
          })
        ["signings"] ->
          only(req, Get, fn() { signings.org_page(ctx, req, org.org.id) })
        ["transitions"] ->
          only(req, Get, fn() { transitions.org_list(ctx, org.org.id) })
        ["audit"] -> only(req, Get, fn() { org_audit.feed(ctx, req, org) })
        ["audit", "export"] ->
          only(req, Get, fn() { audit_export.export(ctx, org) })
        ["staff"] -> only(req, Get, fn() { staff_routes.list(ctx, org) })
        ["tactical"] -> only(req, Post, fn() { tactical(org) })
        ["staff", user_id, "remove"] ->
          only(req, Post, fn() {
            staff_routes.remove(ctx, org, id.org_user(user_id))
          })
        ["invites"] ->
          only(req, Post, fn() { invite_routes.create(ctx, req, org) })
        ["mfa", "setup"] ->
          only(req, Post, fn() { mfa_routes.setup(ctx, req, org) })
        ["mfa", "verify"] ->
          only(req, Post, fn() { mfa_routes.verify(ctx, req, org) })
        ["mfa", "disable"] ->
          only(req, Post, fn() { mfa_routes.disable(ctx, req, org) })
        ["delivery", "prefs"] ->
          only(req, Put, fn() { delivery_prefs.put(ctx, req, org) })
        ["players", id] ->
          only(req, Get, fn() { discovery.profile(ctx, org, id.player(id)) })
        ["players", id, "notes"] ->
          only(req, Post, fn() {
            discovery.add_note(ctx, req, org, id.player(id))
          })
        ["players", id, "save"] ->
          only(req, Post, fn() {
            discovery.mark(ctx, req, org, id.player(id), ledger_row.Save)
          })
        ["players", id, "shortlist"] ->
          only(req, Post, fn() {
            discovery.mark(ctx, req, org, id.player(id), ledger_row.Shortlist)
          })
        ["players", id, "request"] ->
          only(req, Post, fn() {
            request_routes.request(ctx, req, org, id.player(id))
          })
        ["players", id, "evidence"] ->
          only(req, Post, fn() {
            evidence.club_submit(ctx, req, org, id.player(id))
          })
        ["players", id, "evidence-gaps"] ->
          only(req, Get, fn() { evidence_gaps.gaps(ctx, org, id.player(id)) })
        ["combine", "protocols"] ->
          only(req, Get, fn() { combine.protocols(ctx) })
        ["combine", "players", id] ->
          only(req, Get, fn() {
            combine.player_results(ctx, org, id.player(id))
          })
        ["players", id, "trust-profile"] ->
          only(req, Get, fn() { trust.org_view(ctx, org, id.player(id)) })
        ["players", pid, "assessment-compare"] ->
          only(req, Get, fn() { assessments.compare(ctx, org, pid) })
        ["assessments"] ->
          case req.method {
            Get -> assessments.list_for(ctx, req, org)
            Post -> assessments.create(ctx, req, org)
            _ -> not_found()
          }
        ["assessments", aid] ->
          only(req, Put, fn() {
            use req <- contract.rerun_on_stale(req)
            assessments.edit(ctx, req, org, aid)
          })
        ["assessments", aid, "submit"] ->
          only(req, Post, fn() { assessments.submit(ctx, org, aid) })
        ["shortlist"] -> only(req, Get, fn() { discovery.shortlist(ctx, org) })
        ["review-queue"] ->
          only(req, Get, fn() { review_queue.review_queue(ctx, org) })
        ["recruitment", "lifecycle"] ->
          only(req, Get, fn() { lifecycle.vocabulary(ctx) })
        ["players"] ->
          only(req, Get, fn() { directory.directory(ctx, req, org) })
        ["filmroom"] ->
          only(req, Get, fn() { directory.film_room(ctx, req, org) })
        ["fixtures"] ->
          only(req, Get, fn() { directory.fixtures(ctx, req, org) })
        ["ledger"] ->
          only(req, Get, fn() { request_routes.org_ledger(ctx, req, org) })
        ["funnel"] -> only(req, Get, fn() { request_routes.funnel(ctx, org) })
        ["report"] ->
          only(req, Post, fn() { report_routes.org_report(ctx, req, org) })
        ["reports"] ->
          only(req, Get, fn() { report_routes.org_reports(ctx, org) })
        ["notifications"] ->
          only(req, Get, fn() {
            feed_routes.feed(
              ctx,
              audience.OrgUser,
              id.org_user_to_string(org.user.id),
            )
          })
        ["notifications", "read"] ->
          only(req, Post, fn() {
            feed_routes.read(
              ctx,
              req,
              audience.OrgUser,
              id.org_user_to_string(org.user.id),
            )
          })
        ["notifications", id, "ack"] ->
          only(req, Post, fn() {
            delivery.ack(
              ctx,
              audience.OrgUser,
              id.org_user_to_string(org.user.id),
              id.notification(id),
            )
          })
        ["notification-preferences"] ->
          case req.method {
            Get ->
              notification_prefs.show(
                ctx,
                audience.OrgUser,
                id.org_user_to_string(org.user.id),
              )
            Put ->
              notification_prefs.update(
                ctx,
                req,
                audience.OrgUser,
                id.org_user_to_string(org.user.id),
              )
            _ -> not_found()
          }
        ["delivery"] ->
          only(req, Get, fn() { delivery.org_list(ctx, req, org) })
        ["webhooks"] -> only(req, Post, fn() { webhooks.create(ctx, req, org) })
        ["support"] -> only(req, Post, fn() { support.create(ctx, req, org) })
        ["squad"] ->
          only(req, Post, fn() { grassroots_club.add_to_squad(ctx, req, org) })
        ["open-trials"] ->
          only(req, Post, fn() {
            grassroots_club.post_open_trial(ctx, req, org)
          })
        ["friendlies"] ->
          only(req, Post, fn() { grassroots_club.post_friendly(ctx, req, org) })
        ["searches"] ->
          only(req, Post, fn() { saved_searches.create(ctx, req, org) })
        ["channels"] -> only(req, Get, fn() { threads.org_list(ctx, req, org) })
        ["channels", "counts"] ->
          only(req, Get, fn() { threads.org_counts(ctx, org) })
        ["channels", id, "messages"] ->
          only(req, Post, fn() {
            threads.org_send(ctx, req, org, id.channel(id))
          })
        ["channels", id, "read"] ->
          only(req, Post, fn() {
            threads.org_read(ctx, req, org, id.channel(id))
          })
        ["channels", id, "typing"] ->
          only(req, Post, fn() {
            threads.org_typing(ctx, req, org, id.channel(id))
          })
        _ -> not_found()
      }
    }
    ["player", ..rest] -> {
      use player <- access.player_session(ctx, req)
      case rest {
        ["inbox"] ->
          only(req, Get, fn() { request_routes.player_inbox(ctx, req, player) })
        ["football-passport"] ->
          only(req, Get, fn() { football_passport.player_view(ctx, player) })
        ["insights"] -> only(req, Get, fn() { insights.show(ctx, player) })
        ["journeys"] ->
          only(req, Get, fn() { case_routes.player_journeys(ctx, req, player) })
        ["box-cam", "sessions", sid, "cv", "finalize"] ->
          only(req, Post, fn() { box_prefs.cv_finalize(ctx, player, sid) })
        ["box-cam", "prefs"] ->
          case req.method {
            Get -> box_prefs.show(ctx, player)
            Patch -> box_prefs.update(ctx, req, player)
            _ -> not_found()
          }
        ["agent", "relationships"] ->
          only(req, Get, fn() { agent.my_agent(ctx, player) })
        ["agent", "relationships", rid, "confirm"] ->
          only(req, Post, fn() {
            agent.answer(ctx, req, player, rid, agent.Confirm)
          })
        ["agent", "relationships", rid, "decline"] ->
          only(req, Post, fn() {
            agent.answer(ctx, req, player, rid, agent.Decline)
          })
        ["agent", "relationships", rid, "terminate"] ->
          only(req, Post, fn() {
            agent.answer(ctx, req, player, rid, agent.End)
          })
        ["agent", "relationships", rid, "dispute"] ->
          only(req, Post, fn() {
            agent.answer(ctx, req, player, rid, agent.Dispute)
          })
        ["agent", "relationships", rid, "sharing"] ->
          only(req, Patch, fn() { agent.sharing(ctx, req, player, rid) })
        ["account"] ->
          only(req, Delete, fn() { erasure.delete_account(ctx, player) })
        ["opportunity-board"] ->
          only(req, Get, fn() { board_routes.player_board(ctx, req, player) })
        ["offers"] ->
          only(req, Get, fn() {
            offer_routes.list_for(
              ctx,
              req,
              offer_routes.PlayerRecipient(player),
            )
          })
        ["offers", oid] ->
          only(req, Get, fn() {
            offer_routes.read_one(
              ctx,
              req,
              offer_routes.PlayerRecipient(player),
              oid,
            )
          })
        ["trials"] ->
          only(req, Get, fn() {
            trial_day.list_for(ctx, trial_day.PlayerFamily(player))
          })
        ["trials", tid, "safety-pack"] ->
          only(req, Get, fn() {
            trial_day.safety_pack(ctx, trial_day.PlayerFamily(player), tid)
          })
        ["trials", tid, "consent"] ->
          only(req, Post, fn() {
            trial_day.consent(ctx, trial_day.PlayerFamily(player), tid)
          })
        ["trials", tid, "emergency-contact"] ->
          only(req, Post, fn() {
            trial_day.emergency(ctx, req, trial_day.PlayerFamily(player), tid)
          })
        ["trials", tid, "confirm-schedule"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            trial_routes.confirm(ctx, req, trial_routes.PlayerSide(player), tid)
          })
        ["trials", tid, "decline-schedule"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            trial_routes.decline(ctx, req, trial_routes.PlayerSide(player), tid)
          })
        ["trials", tid, "cancel"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            trial_routes.recipient_cancel(
              ctx,
              req,
              trial_routes.PlayerSide(player),
              tid,
            )
          })
        ["offers", oid, "accept"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            offer_routes.respond(
              ctx,
              req,
              offer_routes.PlayerRecipient(player),
              oid,
              True,
            )
          })
        ["offers", oid, "decline"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            offer_routes.respond(
              ctx,
              req,
              offer_routes.PlayerRecipient(player),
              oid,
              False,
            )
          })
        ["offers", oid, "share-agent"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            offer_routes.share_agent(ctx, req, player, oid)
          })
        ["offers", oid, "documents", doc] ->
          only(req, Get, fn() {
            offer_routes.document(
              ctx,
              req,
              offer_routes.PlayerRecipient(player),
              oid,
              doc,
            )
          })
        ["block"] ->
          only(req, Post, fn() { report_routes.player_block(ctx, req, player) })
        ["report"] ->
          only(req, Post, fn() { report_routes.player_report(ctx, req, player) })
        ["reports"] ->
          only(req, Get, fn() { report_routes.player_reports(ctx, player) })
        ["timeline"] ->
          only(req, Post, fn() { player_routes.add_timeline(ctx, req, player) })
        ["export"] -> only(req, Get, fn() { player_routes.export(ctx, player) })
        ["verification", "org", id] ->
          only(req, Get, fn() { personal.public_org(ctx, id.org(id)) })
        ["invites", "accept"] ->
          only(req, Post, fn() { invites.player_accept(ctx, req, player) })
        ["references"] -> only(req, Get, fn() { references.mine(ctx, player) })
        ["me"] -> only(req, Get, fn() { record.me(player) })
        ["trust-profile"] ->
          only(req, Get, fn() { trust.player_view(ctx, player) })
        ["availability"] ->
          only(req, Post, fn() { record.availability(ctx, req, player) })
        ["first-team-seeker"] ->
          only(req, Post, fn() { record.first_team_seeker(ctx, req, player) })
        ["academyplus"] ->
          only(req, Post, fn() { record.academy_plus(ctx, req, player) })
        ["medical", "share"] ->
          only(req, Post, fn() { record.medical_share(ctx, req, player) })
        ["stats"] -> only(req, Post, fn() { record.stats(ctx, req, player) })
        ["media"] -> only(req, Post, fn() { record.media(ctx, req, player) })
        ["medical", "records"] ->
          only(req, Post, fn() { record.medical_record(ctx, req, player) })
        ["badges"] -> only(req, Post, fn() { record.badges(ctx, req, player) })
        ["prefs"] -> only(req, Post, fn() { record.prefs(ctx, req, player) })
        ["notifications"] ->
          only(req, Get, fn() {
            feed_routes.feed(
              ctx,
              audience.Player,
              id.player_to_string(player.player.row.id),
            )
          })
        ["notifications", "read"] ->
          only(req, Post, fn() {
            feed_routes.read(
              ctx,
              req,
              audience.Player,
              id.player_to_string(player.player.row.id),
            )
          })
        ["notifications", id, "ack"] ->
          only(req, Post, fn() {
            delivery.ack(
              ctx,
              audience.Player,
              id.player_to_string(player.player.row.id),
              id.notification(id),
            )
          })
        ["notification-preferences"] ->
          case req.method {
            Get ->
              notification_prefs.show(
                ctx,
                audience.Player,
                id.player_to_string(player.player.row.id),
              )
            Put ->
              notification_prefs.update(
                ctx,
                req,
                audience.Player,
                id.player_to_string(player.player.row.id),
              )
            _ -> not_found()
          }
        ["transitions"] ->
          only(req, Post, fn() { transitions.player_open(ctx, req, player) })
        ["transitions", id, "recipients"] ->
          only(req, Post, fn() {
            transitions.add_recipient(
              ctx,
              req,
              transitions.PlayerOwner(player),
              id.transition_case(id),
            )
          })
        ["transitions", id, "revoke-recipient"] ->
          only(req, Post, fn() {
            transitions.revoke_recipient(
              ctx,
              req,
              transitions.PlayerOwner(player),
              id.transition_case(id),
            )
          })
        ["channels"] ->
          only(req, Get, fn() { threads.player_list(ctx, player) })
        ["channels", id, "messages"] ->
          only(req, Post, fn() {
            threads.player_send(ctx, req, player, id.channel(id))
          })
        ["channels", id, "read"] ->
          only(req, Post, fn() {
            threads.player_read(ctx, req, player, id.channel(id))
          })
        ["channels", id, "typing"] ->
          only(req, Post, fn() {
            threads.player_typing(ctx, req, player, id.channel(id))
          })
        ["requests", id, "respond"] ->
          only(req, Post, fn() {
            request_routes.player_respond(ctx, req, player, id.request(id))
          })
        _ -> not_found()
      }
    }
    ["guardian", ..rest] -> {
      use guardian <- access.guardian_session(ctx, req)
      case rest {
        ["verification", "org", id] ->
          only(req, Get, fn() { personal.public_org(ctx, id.org(id)) })
        ["invites", "accept"] ->
          only(req, Post, fn() { invites.guardian_accept(ctx, req, guardian) })
        ["children", cid] ->
          only(req, Delete, fn() {
            erasure.delete_child(ctx, guardian, id.player(cid))
          })
        ["children", cid, "journeys"] ->
          only(req, Get, fn() {
            case_routes.guardian_journeys(ctx, req, guardian, id.player(cid))
          })
        ["children", id, "references"] ->
          only(req, Get, fn() { references.child(ctx, guardian, id.player(id)) })
        ["me"] -> only(req, Get, fn() { guardian_routes.me(guardian) })
        ["offers"] ->
          only(req, Get, fn() {
            offer_routes.list_for(
              ctx,
              req,
              offer_routes.GuardianRecipient(guardian),
            )
          })
        ["offers", oid] ->
          only(req, Get, fn() {
            offer_routes.read_one(
              ctx,
              req,
              offer_routes.GuardianRecipient(guardian),
              oid,
            )
          })
        ["trials"] ->
          only(req, Get, fn() {
            trial_day.list_for(ctx, trial_day.GuardianFamily(guardian))
          })
        ["trials", tid, "safety-pack"] ->
          only(req, Get, fn() {
            trial_day.safety_pack(ctx, trial_day.GuardianFamily(guardian), tid)
          })
        ["trials", tid, "consent"] ->
          only(req, Post, fn() {
            trial_day.consent(ctx, trial_day.GuardianFamily(guardian), tid)
          })
        ["trials", tid, "emergency-contact"] ->
          only(req, Post, fn() {
            trial_day.emergency(
              ctx,
              req,
              trial_day.GuardianFamily(guardian),
              tid,
            )
          })
        ["trials", tid, "confirm-schedule"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            trial_routes.confirm(
              ctx,
              req,
              trial_routes.GuardianSide(guardian),
              tid,
            )
          })
        ["trials", tid, "decline-schedule"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            trial_routes.decline(
              ctx,
              req,
              trial_routes.GuardianSide(guardian),
              tid,
            )
          })
        ["trials", tid, "cancel"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            trial_routes.recipient_cancel(
              ctx,
              req,
              trial_routes.GuardianSide(guardian),
              tid,
            )
          })
        ["offers", oid, "accept"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            offer_routes.respond(
              ctx,
              req,
              offer_routes.GuardianRecipient(guardian),
              oid,
              True,
            )
          })
        ["offers", oid, "decline"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            offer_routes.respond(
              ctx,
              req,
              offer_routes.GuardianRecipient(guardian),
              oid,
              False,
            )
          })
        ["offers", oid, "documents", doc] ->
          only(req, Get, fn() {
            offer_routes.document(
              ctx,
              req,
              offer_routes.GuardianRecipient(guardian),
              oid,
              doc,
            )
          })
        ["children"] ->
          case req.method {
            Get -> guardian_routes.children(ctx, guardian)
            Post -> player_routes.create_child(ctx, req, guardian)
            _ -> not_found()
          }
        ["children", id, "availability"] ->
          only(req, Post, fn() {
            record.child_availability(ctx, req, guardian, id.player(id))
          })
        ["children", id, "medical", "share"] ->
          only(req, Post, fn() {
            record.child_medical_share(ctx, req, guardian, id.player(id))
          })
        ["coguardian"] ->
          only(req, Post, fn() {
            guardian_routes.add_co_guardian(ctx, req, guardian)
          })
        ["log"] ->
          only(req, Get, fn() { guardian_routes.log(ctx, req, guardian) })
        ["report"] ->
          only(req, Post, fn() {
            report_routes.guardian_report(ctx, req, guardian)
          })
        ["reports"] ->
          only(req, Get, fn() { report_routes.guardian_reports(ctx, guardian) })
        ["block"] ->
          only(req, Post, fn() {
            report_routes.guardian_block(ctx, req, guardian)
          })
        ["inbox"] ->
          only(req, Get, fn() {
            request_routes.guardian_inbox(ctx, req, guardian)
          })
        ["notifications"] ->
          only(req, Get, fn() {
            feed_routes.feed(
              ctx,
              audience.Guardian,
              id.guardian_to_string(guardian.row.id),
            )
          })
        ["notifications", "read"] ->
          only(req, Post, fn() {
            feed_routes.read(
              ctx,
              req,
              audience.Guardian,
              id.guardian_to_string(guardian.row.id),
            )
          })
        ["notifications", id, "ack"] ->
          only(req, Post, fn() {
            delivery.ack(
              ctx,
              audience.Guardian,
              id.guardian_to_string(guardian.row.id),
              id.notification(id),
            )
          })
        ["notification-preferences"] ->
          case req.method {
            Get ->
              notification_prefs.show(
                ctx,
                audience.Guardian,
                id.guardian_to_string(guardian.row.id),
              )
            Put ->
              notification_prefs.update(
                ctx,
                req,
                audience.Guardian,
                id.guardian_to_string(guardian.row.id),
              )
            _ -> not_found()
          }
        ["children", id, "transitions"] ->
          only(req, Post, fn() {
            transitions.guardian_open(ctx, req, guardian, id.player(id))
          })
        ["children-transitions", id, "recipients"] ->
          only(req, Post, fn() {
            transitions.add_recipient(
              ctx,
              req,
              transitions.GuardianOwner(guardian),
              id.transition_case(id),
            )
          })
        ["children-transitions", id, "revoke-recipient"] ->
          only(req, Post, fn() {
            transitions.revoke_recipient(
              ctx,
              req,
              transitions.GuardianOwner(guardian),
              id.transition_case(id),
            )
          })
        ["channels"] ->
          only(req, Get, fn() { threads.guardian_list(ctx, guardian) })
        ["channels", id, "messages"] ->
          only(req, Post, fn() {
            threads.guardian_send(ctx, req, guardian, id.channel(id))
          })
        ["channels", id, "read"] ->
          only(req, Post, fn() {
            threads.guardian_read(ctx, req, guardian, id.channel(id))
          })
        ["channels", id, "typing"] ->
          only(req, Post, fn() {
            threads.guardian_typing(ctx, req, guardian, id.channel(id))
          })
        ["requests", id, "respond"] ->
          only(req, Post, fn() {
            request_routes.guardian_respond(ctx, req, guardian, id.request(id))
          })
        _ -> not_found()
      }
    }
    ["admin", ..rest] -> {
      use <- access.admin(ctx, req)
      case rest {
        ["verification", ..path] -> verification_admin(ctx, req, path)
        ["agent", "relationships"] ->
          only(req, Get, fn() { agent.admin_relationships(ctx, req) })
        ["agent", "profiles"] ->
          only(req, Get, fn() { agent.admin_profiles(ctx, req) })
        ["outbox"] -> only(req, Get, fn() { admin.outbox(ctx, req) })
        ["channels"] -> only(req, Get, fn() { threads.admin_list(ctx, req) })
        ["push-log"] -> only(req, Get, fn() { console.push_log(ctx, req) })
        ["support", id, "reply"] ->
          only(req, Post, fn() { support.reply(ctx, req, id.ticket(id)) })
        ["delivery"] -> only(req, Get, fn() { delivery.admin_view(ctx) })
        ["delivery", "sweep"] ->
          only(req, Post, fn() { delivery.admin_sweep(ctx, req) })
        ["delivery", "inject-failure"] ->
          only(req, Post, fn() { delivery.inject_failure(ctx, req) })
        ["overview"] -> only(req, Get, fn() { console.overview(ctx) })
        ["metrics"] -> only(req, Get, fn() { console.metrics(ctx) })
        ["rooms", "overview"] ->
          only(req, Get, fn() { room_routes.admin_overview(ctx) })
        ["reports"] -> only(req, Get, fn() { console.reports(ctx, req) })
        ["reports", id, "resolve"] ->
          only(req, Post, fn() { console.resolve(ctx, req, id) })
        ["blocks"] -> only(req, Get, fn() { console.blocks(ctx, req) })
        ["blocks", id, "lift"] ->
          only(req, Post, fn() { console.lift(ctx, req, id) })
        ["moderation"] -> only(req, Get, fn() { console.moderation(ctx, req) })
        ["clubs"] -> only(req, Get, fn() { console.clubs(ctx, req) })
        ["guardians"] ->
          only(req, Get, fn() { guardian_routes.admin_list(ctx, req) })
        ["guardians", id, "idv"] ->
          only(req, Post, fn() {
            guardian_routes.review_id(ctx, req, id.guardian(id))
          })
        ["clubs", id, "credentials"] ->
          only(req, Post, fn() { console.credentials(ctx, req, id.org(id)) })
        ["clubs", id, "verification"] ->
          only(req, Post, fn() { console.verification(ctx, req, id.org(id)) })
        _ -> not_found()
      }
    }
    _ -> not_found()
  }
}

/// `/admin/verification/…`: Trust & Safety's verification surface.
fn verification_admin(ctx: Ctx, req: Request, path: List(String)) -> Response {
  case path {
    ["orgs", id, "appoint-root"] ->
      only(req, Post, fn() { review.appoint_root(ctx, req, id.org(id)) })
    ["orgs", id, "revoke"] ->
      only(req, Post, fn() { review.revoke_org(ctx, req, id.org(id)) })
    ["queue"] -> only(req, Get, fn() { review.queue(ctx, req) })
    ["cases", id] ->
      only(req, Get, fn() { review.case_view(ctx, id.claim(id)) })
    ["evidence", id] ->
      only(req, Get, fn() { review.admin_evidence(ctx, req, id) })
    ["claims", id, "approve"] ->
      only(req, Post, fn() { review.approve(ctx, req, id.claim(id)) })
    ["claims", id, "reject"] ->
      only(req, Post, fn() { review.reject(ctx, req, id.claim(id)) })
    ["claims", id, "request-info"] ->
      only(req, Post, fn() { review.request_info(ctx, req, id.claim(id)) })
    ["claims", id, "suspend"] ->
      only(req, Post, fn() {
        review.suspend_or_revoke(ctx, req, id.claim(id), claim_row.Suspended)
      })
    ["claims", id, "revoke"] ->
      only(req, Post, fn() {
        review.suspend_or_revoke(ctx, req, id.claim(id), claim_row.Revoked)
      })
    ["claims", id, "reinstate"] ->
      only(req, Post, fn() { review.reinstate(ctx, req, id.claim(id)) })
    ["root-requests", id, "approve"] ->
      only(req, Post, fn() { applications.approve(ctx, req, id) })
    ["root-requests", id, "reject"] ->
      only(req, Post, fn() { applications.reject(ctx, req, id) })
    ["domain-requests"] -> only(req, Get, fn() { review.domain_requests(ctx) })
    ["domain-requests", id, "decide"] ->
      only(req, Post, fn() { review.decide_domain(ctx, req, id) })
    ["disputes"] -> only(req, Get, fn() { review.disputes(ctx) })
    ["disputes", id, "resolve"] ->
      only(req, Post, fn() { review.resolve_dispute(ctx, req, id) })
    ["authorities", id, "claims"] ->
      only(req, Get, fn() { review.authority_claims(ctx, id) })
    ["authorities", id, "flag"] ->
      only(req, Post, fn() { review.flag_authority(ctx, req, id) })
    _ -> not_found()
  }
}

/// `/org/verification/…`: a staff member's own verification and their organisation's console.
fn verification_org(
  ctx: Ctx,
  req: Request,
  org: access.OrgAccess,
  path: List(String),
) -> Response {
  case path {
    ["email"] ->
      only(req, Post, fn() {
        club_checks.request_email_challenge(ctx, req, org)
      })
    ["me"] -> only(req, Get, fn() { personal.me(ctx, org) })
    ["identity"] -> only(req, Post, fn() { personal.identity(ctx, req, org) })
    ["claims", id, "evidence"] ->
      only(req, Post, fn() { personal.evidence(ctx, req, org, id.claim(id)) })
    ["claims", id, "submit"] ->
      only(req, Post, fn() { personal.submit(ctx, req, org, id.claim(id)) })
    ["claims", id, "dispute"] ->
      only(req, Post, fn() { personal.dispute(ctx, req, org, id.claim(id)) })
    ["affiliation"] ->
      only(req, Post, fn() { personal.affiliation(ctx, req, org) })
    ["work-email"] ->
      only(req, Post, fn() { personal.work_email(ctx, req, org) })
    ["work-email", "confirm"] ->
      only(req, Post, fn() { personal.confirm_work_email(ctx, req, org) })
    ["public", "user", id] ->
      only(req, Get, fn() { personal.public_user(ctx, id.org_user(id)) })
    ["public", "org", id] ->
      only(req, Get, fn() { personal.public_org(ctx, id.org(id)) })
    ["public", "users"] ->
      only(req, Get, fn() { personal.public_users(ctx, req) })
    ["dashboard"] ->
      only(req, Get, fn() { verification_console.dashboard(ctx, org) })
    ["requests"] ->
      only(req, Get, fn() { verification_console.requests(ctx, org) })
    ["requests", id, "decide"] ->
      only(req, Post, fn() {
        verification_console.decide(ctx, req, org, id.claim(id))
      })
    ["staff"] ->
      only(req, Get, fn() { verification_console.staff_register(ctx, req, org) })
    ["staff", id, "departed"] ->
      only(req, Post, fn() {
        verification_console.departed(ctx, req, org, id.org_user(id))
      })
    ["references"] ->
      case req.method {
        Get -> references.list_for_org(ctx, org)
        Post -> references.create(ctx, req, org)
        _ -> not_found()
      }
    ["references", id, "withdraw"] ->
      only(req, Post, fn() { references.withdraw(ctx, req, org, id) })
    ["references", id, "correct"] ->
      only(req, Post, fn() { references.correct(ctx, req, org, id) })
    ["player-invites"] ->
      case req.method {
        Get -> invites.list_invites(ctx, org)
        Post -> invites.create(ctx, req, org)
        _ -> not_found()
      }
    ["licence-providers"] ->
      only(req, Get, fn() { review.licence_providers(ctx) })
    ["licence"] -> only(req, Post, fn() { review.new_licence(ctx, req, org) })
    ["licence", id, "submit"] ->
      only(req, Post, fn() {
        review.submit_licence(ctx, req, org, id.claim(id))
      })
    ["evidence", id] ->
      only(req, Get, fn() { review.org_evidence(ctx, req, org, id) })
    ["domains"] ->
      case req.method {
        Get -> org_admin.domains(ctx, org)
        Post -> org_admin.add_domain(ctx, req, org)
        _ -> not_found()
      }
    ["domains", id, "confirm"] ->
      only(req, Post, fn() { org_admin.confirm_domain(ctx, req, org, id) })
    ["admins"] ->
      case req.method {
        Get -> org_admin.admins(ctx, org)
        Post -> org_admin.grant(ctx, req, org)
        _ -> not_found()
      }
    ["admins", id, "revoke"] ->
      only(req, Post, fn() { org_admin.revoke(ctx, req, org, id.ver_admin(id)) })
    ["root-transfers", id, "approve"] ->
      only(req, Post, fn() {
        org_admin.approve_transfer(ctx, req, org, id.root_transfer(id))
      })
    ["conflicts"] ->
      case req.method {
        Get -> org_admin.list_conflicts(ctx, org)
        Post -> org_admin.declare(ctx, req, org)
        _ -> not_found()
      }
    ["conflicts", id, "withdraw"] ->
      only(req, Post, fn() { org_admin.withdraw_conflict(ctx, org, id) })
    _ -> not_found()
  }
}

fn only(
  req: Request,
  method: http.Method,
  handler: fn() -> Response,
) -> Response {
  case req.method == method {
    True -> handler()
    False -> not_found()
  }
}

/// The Agent workspace (`/org/agent/…`).
fn agent_org(
  ctx: Ctx,
  req: Request,
  org: OrgAccess,
  path: List(String),
) -> Response {
  case path {
    ["transactions"] ->
      only(req, Post, fn() { transaction_routes.create(ctx, req, org) })
    ["transactions", tid, "notes"] ->
      only(req, Post, fn() {
        use req <- contract.rerun_on_stale(req)
        transaction_routes.add_note(ctx, req, org, tid)
      })
    ["me"] -> only(req, Get, fn() { agent.me(ctx, org) })
    ["home"] -> only(req, Get, fn() { agent.home(ctx, org) })
    ["profile"] ->
      case req.method {
        Get -> agent.profile(ctx, org)
        Post -> agent.save_profile(ctx, req, org)
        _ -> not_found()
      }
    ["profile", "facets", facet, "submit"] ->
      only(req, Post, fn() { agent.submit_facet(ctx, req, org, facet) })
    ["agency"] -> only(req, Get, fn() { agent.agency(ctx, org) })
    ["agency", "team"] ->
      case req.method {
        Get -> agent.team(ctx, org)
        Post -> agent.add_member(ctx, req, org)
        _ -> not_found()
      }
    ["agency", "team", user_id] ->
      only(req, Patch, fn() { agent.set_member_tiers(ctx, req, org, user_id) })
    ["agency", "team", user_id, "end"] ->
      only(req, Post, fn() { agent.end_member(ctx, req, org, user_id) })
    ["agency", "settings"] ->
      only(req, Patch, fn() { agent.save_settings(ctx, req, org) })
    ["agency", "compliance"] ->
      only(req, Get, fn() { agent.compliance(ctx, org) })
    ["agency", "audit"] ->
      only(req, Get, fn() { agent.agency_audit(ctx, req, org) })
    ["players"] -> only(req, Get, fn() { agent.players_lookup(ctx, req, org) })
    ["clients"] -> only(req, Get, fn() { agent.clients(ctx, org) })
    ["clients", "request"] ->
      only(req, Post, fn() { agent.request(ctx, req, org) })
    ["clients", rid] -> only(req, Get, fn() { agent.client(ctx, org, rid) })
    ["clients", rid, "terminate"] ->
      only(req, Post, fn() { agent.terminate(ctx, req, org, rid) })
    ["clients", rid, "offers"] ->
      only(req, Get, fn() { offer_routes.agent_offers(ctx, req, org, rid) })
    ["clients", rid, "journey"] ->
      only(req, Get, fn() { case_routes.agent_journey(ctx, req, org, rid) })
    ["clients", rid, "opportunities"] ->
      only(req, Get, fn() { agent.client_opportunities(ctx, org, rid) })
    ["opportunities"] -> only(req, Get, fn() { agent.opportunities(ctx, org) })
    ["inbox"] -> only(req, Get, fn() { agent.inbox(ctx, org) })
    _ -> not_found()
  }
}

/// Express answers an unknown route with an HTML page; this server answers in the error contract.
fn not_found() -> Response {
  contract.error(404, "NOT_FOUND")
}

/// The headers on every response, as the TypeScript server's HTTP baseline sets them: the schema version, the
/// browser hardening headers, and on an error whether a retry could succeed. A response that already says
/// whether it is retryable (a simulated fault) keeps its own answer.
fn baseline(ctx: Ctx, handler: fn() -> Response) -> Response {
  let response =
    handler()
    |> contract.settled
    |> wisp.set_header("x-scoutbox-schema", int.to_string(ctx.schema_version))
    |> wisp.set_header("x-content-type-options", "nosniff")
    |> wisp.set_header("referrer-policy", "no-referrer")
    |> wisp.set_header("x-frame-options", "DENY")
    |> wisp.set_header("cross-origin-resource-policy", "same-site")
    |> wisp.set_header(
      "permissions-policy",
      "geolocation=(), microphone=(), payment=()",
    )
  case
    response.status >= 400,
    list.key_find(response.headers, "x-scoutbox-retry")
  {
    True, Error(Nil) ->
      wisp.set_header(response, "x-scoutbox-retry", case response.status {
        429 | 502 | 503 | 504 -> "retryable"
        _ -> "not-retryable"
      })
    _, _ -> response
  }
}

/// The development fault layer, in front of every route but its own.
fn fault(ctx: Ctx, req: Request, next: fn() -> Response) -> Response {
  case faults.for_path(ctx.faults, req.path) {
    faults.Pass -> next()
    faults.Pause(ms) -> {
      faults.pause(ms)
      next()
    }
    faults.Fail(after_ms:, status:, error:, retryable:, message:) -> {
      faults.pause(after_ms)
      contract.json(
        status,
        json.object([
          #("error", json.string(error)),
          #("message", json.string(message)),
          #("retryable", json.bool(retryable)),
          #("simulated", json.bool(True)),
          #("requestId", json.null()),
        ]),
      )
      |> wisp.set_header("x-scoutbox-retry", case retryable {
        True -> "retryable"
        False -> "not-retryable"
      })
    }
  }
}

/// A crash in a handler is a 500 with fixed text; the detail goes to the log.
fn rescue(handler: fn() -> Response) -> Response {
  case exception.rescue(handler) {
    Ok(response) -> response
    Error(crash) -> contract.internal(crash)
  }
}

/// Every /auth request counts against its client address: 40 a minute.
fn auth_limit(ctx: Ctx, req: Request, next: fn() -> Response) -> Response {
  let address = contract.header(req, wisp_ewe.peer_header) |> result.unwrap("?")
  case limits.auth_request(ctx.limits, "auth:" <> address, clock.now_ms()) {
    Ok(Nil) -> next()
    Error(retry_after) ->
      contract.json(
        429,
        json.object([
          #("error", json.string("RATE_LIMITED")),
          #(
            "message",
            json.string("Too many attempts — wait a minute and try again."),
          ),
          #("retryAfterMs", json.int(retry_after)),
        ]),
      )
  }
}

/// `POST /auth/sso/start` and `/callback`. The only identity provider is the local test one, so outside
/// development both refuse before reading anything. Not ported yet: the test provider and the relying party behind
/// it (enterprise SSO).
fn sso(ctx: Ctx) -> Response {
  case ctx.config.dev_logins {
    False ->
      contract.error_message(
        403,
        "SSO_PROVIDER_UNAVAILABLE",
        "Only the local test identity provider exists, and it is disabled outside development. Staff sign in with their organisation credentials.",
      )
    True -> not_ported("Staff SSO is")
  }
}

/// `POST /org/tactical`: a lead's tactical setup. Not ported yet: the setup itself (club setup, scouting), and
/// `GET /org/tactical`. Only the lead gate is here.
fn tactical(org: access.OrgAccess) -> Response {
  use <- access.require_lead(org)
  not_ported("Tactical setups are")
}

fn not_ported(subject: String) -> Response {
  contract.error_message(
    501,
    "NOT_PORTED",
    subject <> " not supported by this server yet.",
  )
}

/// `POST /auth/logout`: ends the presented session, if there is one.
fn logout(ctx: Ctx, req: Request) -> Response {
  let ended = case contract.bearer(req) {
    Error(Nil) -> Ok(Nil)
    Ok(token) ->
      store.unit(ctx.store, fn(tx) {
        use session <- result.try(sessions.by_token(
          store.reading(tx),
          token,
          clock.now_ms(),
          ctx.config.session_ttl_ms,
        ))
        case session {
          Some(s) -> sessions.revoke_sid(tx, s.sid)
          None -> Ok(Nil)
        }
      })
  }
  case ended {
    Ok(Nil) -> contract.json(200, json.object([#("ok", json.bool(True))]))
    Error(failure) -> contract.internal(failure)
  }
}

/// Every `/media/<id>` value a response carries leaves signed for the requesting session.
fn signed_media(ctx: Ctx, req: Request, handler: fn() -> Response) -> Response {
  links.sign(ctx, req, handler())
}

/// `GET /healthz`: up, for how long, and on which schema.
fn healthz(ctx: Ctx) -> Response {
  contract.json(
    200,
    json.object([
      #("ok", json.bool(True)),
      #("uptimeS", json.int({ clock.now_ms() - ctx.booted_at + 500 } / 1000)),
      #("schemaVersion", json.int(ctx.schema_version)),
    ]),
  )
}

/// States and counts only.
fn health(ctx: Ctx) -> Response {
  let counts =
    store.read(ctx.store, fn(read) {
      use players <- result.try(players.count(read))
      use orgs <- result.map(orgs.count(read))
      #(players, orgs)
    })
  case counts {
    Error(failure) -> contract.internal(failure)
    Ok(#(player_count, org_count)) ->
      contract.json(
        200,
        json.object([
          #("ok", json.bool(True)),
          #("service", json.string("scoutbox-server")),
          #("engine", json.string("sqlite")),
          #("devLogins", json.bool(ctx.config.dev_logins)),
          #("uptimeSec", json.int({ clock.now_ms() - ctx.booted_at } / 1000)),
          #("players", json.int(player_count)),
          #("orgs", json.int(org_count)),
        ]),
      )
  }
}

/// `/org/rooms…`: the Recruitment Rooms.
fn rooms(
  ctx: Ctx,
  req: Request,
  org: OrgAccess,
  path: List(String),
) -> Response {
  let room = fn(rid) { id.recruitment_case(rid) }
  case path, req.method {
    [], Get -> room_routes.list_rooms(ctx, req, org)
    [], Post -> room_routes.create(ctx, req, org)
    ["needs-attention"], Get -> room_routes.needs_attention(ctx, org)
    ["summaries"], Get -> room_routes.summaries(ctx, req, org)
    [rid], Get -> room_routes.get(ctx, org, room(rid))
    [rid], Patch -> room_routes.edit(ctx, req, org, room(rid))
    [rid, "status"], Post -> room_routes.move_status(ctx, req, org, room(rid))
    [rid, "snapshots"], Get -> room_routes.snapshots(ctx, org, room(rid))
    [rid, "activity"], Get -> room_routes.activity(ctx, req, org, room(rid))
    [rid, "comments"], Get -> room_routes.comments(ctx, req, org, room(rid))
    [rid, "comments"], Post -> room_routes.add_comment(ctx, req, org, room(rid))
    [rid, "comments", cid], Patch ->
      room_routes.edit_comment(ctx, req, org, room(rid), cid)
    [rid, "comments", cid], Delete ->
      room_routes.delete_comment(ctx, org, room(rid), cid)
    [rid, "tasks"], Post -> room_routes.add_task(ctx, req, org, room(rid))
    [rid, "tasks", tid], Patch ->
      room_routes.edit_task(ctx, req, org, room(rid), tid)
    [rid, "decisions"], Post ->
      room_routes.add_decision(ctx, req, org, room(rid))
    [rid, "decisions"], Get -> room_routes.decisions(ctx, org, room(rid))
    [rid, "evidence", eid, "review"], Post ->
      room_routes.review_evidence(ctx, req, org, room(rid), eid)
    [rid, "assessment-assignments"], Post ->
      room_routes.assign_assessment(ctx, req, org, room(rid))
    [rid, "evidence-requests"], Post ->
      room_routes.request_evidence(ctx, req, org, room(rid))
    [rid, "combine-requests"], Post ->
      room_routes.request_combine(ctx, req, org, room(rid))
    [rid, "link"], Post -> room_routes.link(ctx, req, org, room(rid))
    [rid, "contacts"], Get -> contact_routes.list_contacts(ctx, org, rid)
    [rid, "contacts"], Post -> contact_routes.create(ctx, req, org, rid)
    [rid, "contacts", "external"], Post ->
      contact_routes.record_external(ctx, req, org, rid)
    [rid, "contacts", cid], Get -> contact_routes.get(ctx, org, rid, cid)
    [rid, "contacts", cid], Patch -> {
      use req <- contract.rerun_on_stale(req)
      contact_routes.edit(ctx, req, org, rid, cid)
    }
    [rid, "contacts", cid, "cancel"], Post -> {
      use req <- contract.rerun_on_stale(req)
      contact_routes.cancel(ctx, req, org, rid, cid)
    }
    [rid, "contacts", cid, "send"], Post -> {
      use req <- contract.rerun_on_stale(req)
      contact_routes.send(ctx, req, org, rid, cid)
    }
    [rid, "trials"], Get -> trial_routes.list_trials(ctx, org, room(rid))
    [rid, "trials"], Post -> {
      use req <- contract.rerun_on_stale(req)
      trial_routes.invite(ctx, req, org, room(rid))
    }
    [rid, "trials", tid], Get -> trial_routes.get(ctx, org, room(rid), tid)
    [rid, "trials", tid, "schedule"], Post
    | [rid, "trials", tid, "reschedule"], Post
    -> {
      use req <- contract.rerun_on_stale(req)
      trial_routes.schedule(ctx, req, org, room(rid), tid)
    }
    [rid, "trials", tid, "cancel"], Post -> {
      use req <- contract.rerun_on_stale(req)
      trial_routes.cancel(ctx, req, org, room(rid), tid)
    }
    [rid, "trials", tid, "sessions", sid, "attendance"], Post -> {
      use req <- contract.rerun_on_stale(req)
      trial_routes.attendance(ctx, req, org, room(rid), tid, sid)
    }
    [rid, "trials", tid, "complete"], Post -> {
      use req <- contract.rerun_on_stale(req)
      trial_routes.complete(ctx, req, org, room(rid), tid)
    }
    [rid, "trials", tid, "sessions", sid, "evidence"], Post -> {
      use req <- contract.rerun_on_stale(req)
      trial_routes.link(ctx, req, org, room(rid), tid, sid)
    }
    [rid, "trials", tid, "evidence", eid, "unlink"], Post -> {
      use req <- contract.rerun_on_stale(req)
      trial_routes.unlink(ctx, req, org, room(rid), tid, eid)
    }
    [rid, "trials", tid, "evidence", "candidates"], Get ->
      trial_routes.candidates(ctx, org, room(rid), tid)
    [rid, "trials", tid, "evidence"], Get ->
      trial_routes.evidence(ctx, org, room(rid), tid)
    [rid, "offers"], Get -> offer_routes.surface(ctx, req, org, room(rid))
    [rid, "offers"], Post -> {
      use req <- contract.rerun_on_stale(req)
      offer_routes.create(ctx, req, org, room(rid))
    }
    [rid, "transaction-handoff"], Post -> {
      use req <- contract.rerun_on_stale(req)
      handoffs.invite(ctx, req, org, room(rid))
    }
    [rid, "journey"], Get -> case_routes.journey(ctx, req, org, room(rid))
    [rid, "lifecycle"], Post ->
      case_routes.lifecycle_act(ctx, req, org, room(rid))
    [rid, "decision"], Get -> case_routes.decision(ctx, org, room(rid))
    [rid, "decision", "draft"], Post ->
      case_routes.start_draft(ctx, req, org, room(rid))
    [rid, "decision", "draft"], Patch ->
      case_routes.edit_draft(ctx, req, org, room(rid))
    [rid, "decision", "draft"], Delete ->
      case_routes.discard_draft(ctx, req, org, room(rid))
    [rid, "decision", "finalize"], Post ->
      case_routes.finalize(ctx, req, org, room(rid), False)
    [rid, "decision", "supersede"], Post ->
      case_routes.finalize(ctx, req, org, room(rid), True)
    _, _ -> not_found()
  }
}
