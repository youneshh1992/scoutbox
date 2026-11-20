//// Every route the server answers, and the middleware in front of them.

import exception
import gleam/http.{Delete, Get, Patch, Post, Put}
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/result
import scoutbox/agents/compliance_overview
import scoutbox/agents/compliance_routes as compliance
import scoutbox/agents/context_routes
import scoutbox/agents/core_routes as agent
import scoutbox/agents/handoffs
import scoutbox/agents/integration_routes
import scoutbox/agents/policy_routes
import scoutbox/agents/review_routes
import scoutbox/agents/transaction_party_routes as party_lanes
import scoutbox/agents/transaction_routes
import scoutbox/agents/transaction_ts_routes
import scoutbox/app.{type Ctx}
import scoutbox/development/benchmarks
import scoutbox/development/box_prefs
import scoutbox/development/box_session_routes
import scoutbox/development/box_training
import scoutbox/development/combine_routes
import scoutbox/development/cv_stub
import scoutbox/development/drill_guidance
import scoutbox/development/grassroots_club
import scoutbox/development/hub_routes
import scoutbox/development/objectives
import scoutbox/development/record_routes as record
import scoutbox/development/vouches
import scoutbox/discovery/directory
import scoutbox/discovery/insights
import scoutbox/discovery/matching_routes
import scoutbox/discovery/nobody_missed
import scoutbox/discovery/org_feed
import scoutbox/discovery/player_routes as discovery
import scoutbox/discovery/saved_searches
import scoutbox/discovery/second_look
import scoutbox/discovery/watchlists
import scoutbox/enterprise/audit_export
import scoutbox/enterprise/backups
import scoutbox/enterprise/org_audit
import scoutbox/enterprise/security_routes
import scoutbox/enterprise/sso
import scoutbox/enterprise/support
import scoutbox/groups/group_routes
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
import scoutbox/insight/calibration
import scoutbox/insight/coverage
import scoutbox/insight/evidence_gaps
import scoutbox/insight/exposure
import scoutbox/insight/review_queue
import scoutbox/integrations/api_keys
import scoutbox/integrations/imports
import scoutbox/integrations/webhooks
import scoutbox/media/links
import scoutbox/messaging/channel_routes as threads
import scoutbox/messaging/delivery
import scoutbox/messaging/delivery_prefs
import scoutbox/messaging/feed_routes
import scoutbox/messaging/live_routes
import scoutbox/messaging/notification_prefs
import scoutbox/operations/follow_ups
import scoutbox/passport/football_passport
import scoutbox/passport/sharing
import scoutbox/passport/trust
import scoutbox/platform/clock
import scoutbox/platform/fault_routes
import scoutbox/platform/faults
import scoutbox/platform/http as contract
import scoutbox/platform/limits
import scoutbox/platform/operator
import scoutbox/platform/request_metrics
import scoutbox/platform/store
import scoutbox/platform/wisp_ewe
import scoutbox/recruitment/analytics
import scoutbox/recruitment/budget_routes
import scoutbox/recruitment/case_routes
import scoutbox/recruitment/case_workspace
import scoutbox/recruitment/contact_routes
import scoutbox/recruitment/invoices
import scoutbox/recruitment/lifecycle
import scoutbox/recruitment/notification_targets
import scoutbox/recruitment/offer_routes
import scoutbox/recruitment/request_routes
import scoutbox/recruitment/room_routes
import scoutbox/recruitment/signing_routes
import scoutbox/recruitment/signings
import scoutbox/recruitment/trial_day
import scoutbox/recruitment/trial_routes
import scoutbox/rows/coach_affiliations as affiliation_row
import scoutbox/rows/evidence_suggestions as suggestion_row
import scoutbox/rows/id
import scoutbox/rows/ledger as ledger_row
import scoutbox/rows/ver_claims as claim_row
import scoutbox/safety/admin
import scoutbox/safety/console_routes as console
import scoutbox/safety/report_routes
import scoutbox/scouting/assessments
import scoutbox/scouting/board_routes
import scoutbox/scouting/campaigns
import scoutbox/scouting/coaches
import scoutbox/scouting/opportunities
import scoutbox/scouting/opportunity_applications as applies
import scoutbox/scouting/passport_routes
import scoutbox/scouting/shadow
import scoutbox/scouting/squad_invites
import scoutbox/scouting/suitability
import scoutbox/scouting/tactical
import scoutbox/scouting/vacancies
import scoutbox/scouting/video
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
  use <- counted(ctx, req)
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
    ["__rate-limits"] ->
      case faults.enabled(ctx.faults) {
        True -> only(req, Get, fn() { rate_limits(ctx) })
        False -> not_found()
      }
    ["health"] -> only(req, Get, fn() { health(ctx) })
    ["vouch", "submit"] -> only(req, Post, fn() { vouches.submit(ctx, req) })
    ["healthz"] -> only(req, Get, fn() { healthz(ctx) })
    ["readyz"] -> only(req, Get, fn() { backups.readyz(ctx) })
    ["passport", "shared", token] ->
      only(req, Get, fn() { sharing.open_public(ctx, req, token) })
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
    // The test identity provider exists only where dev logins do.
    ["testidp", "authorize"] if ctx.config.dev_logins ->
      only(req, Get, fn() { sso.authorize(ctx, req) })
    ["api", "v1", "export", "prospects"] ->
      only(req, Get, fn() { api_keys.export_prospects(ctx, req) })
    ["api", "v1", "export", "shortlist"] ->
      only(req, Get, fn() { api_keys.export_shortlist(ctx, req) })
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
        ["org", "verification", "apply", request_id, "confirm-email"] ->
          only(req, Post, fn() {
            applications.confirm_email(ctx, req, id.root_request(request_id))
          })
        ["org", "verification", "apply", request_id, "evidence"] ->
          only(req, Post, fn() {
            applications.evidence(ctx, req, id.root_request(request_id))
          })
        ["org", "verification", "apply", request_id, "submit"] ->
          only(req, Post, fn() {
            applications.submit(ctx, req, id.root_request(request_id))
          })
        ["org", "verification", "apply", request_id, "status"] ->
          only(req, Get, fn() {
            applications.status(ctx, req, id.root_request(request_id))
          })
        ["player", "login"] ->
          only(req, Post, fn() { player_routes.login(ctx, req) })
        ["reviewer", "login"] ->
          only(req, Post, fn() { compliance.login(ctx, req) })
        ["player", "signup"] ->
          only(req, Post, fn() { player_routes.signup(ctx, req) })
        ["guardian", "signup"] ->
          only(req, Post, fn() { guardian_routes.signup(ctx, req) })
        ["guardian", "login"] ->
          only(req, Post, fn() { guardian_routes.login(ctx, req) })
        ["sso", "start"] -> only(req, Post, fn() { sso.start(ctx, req) })
        ["sso", "callback"] -> only(req, Post, fn() { sso.callback(ctx, req) })
        _ -> not_found()
      }
    }
    // Every /org path needs a staff session, a path the server does not have included.
    ["org", ..rest] -> {
      use org <- access.org_session(ctx, req)
      case rest {
        ["development", ..path] ->
          hub_routes.handle(ctx, req, hub_routes.AsOrg(org), path)
        ["verification", ..path] -> verification_org(ctx, req, org, path)
        ["rooms", ..path] -> rooms(ctx, req, org, path)
        ["agent", ..path] -> agent_org(ctx, req, org, path)
        ["offers", oid] ->
          only(req, Get, fn() { offer_routes.get(ctx, req, org, id.offer(oid)) })
        ["offers", oid, "history"] ->
          only(req, Get, fn() {
            offer_routes.history(ctx, req, org, id.offer(oid))
          })
        ["offers", oid, "signing"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            signing_routes.start(ctx, req, org, id.offer(oid))
          })
        ["signings", sid] ->
          case req.method {
            Get -> signing_routes.get(ctx, req, org, id.signing_package(sid))
            Patch -> {
              use req <- contract.rerun_on_stale(req)
              signing_routes.edit_draft(ctx, req, org, id.signing_package(sid))
            }
            _ -> not_found()
          }
        ["signings", sid, "history"] ->
          only(req, Get, fn() {
            signing_routes.history(ctx, req, org, id.signing_package(sid))
          })
        ["signings", sid, "document"] ->
          case req.method {
            Get ->
              signing_routes.document(ctx, req, org, id.signing_package(sid))
            Post -> {
              use req <- contract.rerun_on_stale(req)
              signing_routes.attach(ctx, req, org, id.signing_package(sid))
            }
            _ -> not_found()
          }
        ["signings", sid, "executed-document"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            signing_routes.attach_executed(
              ctx,
              req,
              org,
              id.signing_package(sid),
            )
          })
        ["signings", sid, "ready"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            signing_routes.ready(ctx, req, org, id.signing_package(sid))
          })
        ["signings", sid, "parties", "club", "complete"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            signing_routes.club_party(ctx, req, org, id.signing_package(sid))
          })
        ["signings", sid, "complete"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            signing_routes.complete(ctx, req, org, id.signing_package(sid))
          })
        ["signings", sid, "cancel"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            signing_routes.close(
              ctx,
              req,
              org,
              id.signing_package(sid),
              signing_routes.Cancel,
            )
          })
        ["signings", sid, "void"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            signing_routes.close(
              ctx,
              req,
              org,
              id.signing_package(sid),
              signing_routes.Void,
            )
          })
        ["signings", sid, "supersede"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            signing_routes.supersede(ctx, req, org, id.signing_package(sid))
          })
        ["offers", oid, "draft"] ->
          only(req, Patch, fn() {
            use req <- contract.rerun_on_stale(req)
            offer_routes.edit_draft(ctx, req, org, id.offer(oid))
          })
        ["offers", oid, "issue"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            offer_routes.issue(ctx, req, org, id.offer(oid))
          })
        ["offers", oid, "withdraw"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            offer_routes.withdraw(ctx, req, org, id.offer(oid))
          })
        ["offers", oid, "revise"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            offer_routes.revise(ctx, req, org, id.offer(oid))
          })
        ["recruitment", "offer-policy"] -> only(req, Get, offer_routes.policy)
        ["recruitment", "trial-policy"] -> only(req, Get, trial_routes.policy)
        ["recruitment", "decision-policy"] ->
          only(req, Get, case_routes.decision_policy)
        ["recruitment", "contact-policy"] ->
          only(req, Get, contact_routes.policy)
        ["rooms-funnel"] ->
          only(req, Get, fn() { room_routes.funnel(ctx, org) })
        ["feed"] -> only(req, Get, fn() { org_feed.feed(ctx, org) })
        ["recruitment-analytics"] ->
          only(req, Get, fn() { analytics.dashboard(ctx, req, org) })
        ["recruitment-analytics", "catalogue"] ->
          only(req, Get, fn() { analytics.catalogue(org) })
        ["recruitment-analytics", "rows"] ->
          only(req, Get, fn() { analytics.rows(ctx, req, org) })
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
        ["cases"] ->
          case req.method {
            Get -> case_workspace.list(ctx, req, org)
            Post -> case_workspace.create(ctx, req, org)
            _ -> not_found()
          }
        ["vacancies"] ->
          case req.method {
            Get -> vacancies.list_for(ctx, req, org)
            Post -> vacancies.create(ctx, req, org)
            _ -> not_found()
          }
        ["vacancies", vid, "close"] ->
          only(req, Post, fn() { vacancies.close(ctx, org, vid) })
        ["vacancies", vid, "candidates"] ->
          only(req, Get, fn() { vacancies.candidates(ctx, req, org, vid) })
        ["squad", "shadow"] ->
          only(req, Post, fn() { shadow.add(ctx, req, org) })
        ["squad-planner"] -> only(req, Get, fn() { shadow.planner(ctx, org) })
        ["cases", cid] ->
          only(req, Get, fn() { case_workspace.get(ctx, org, cid) })
        ["cases", cid, "assign"] ->
          only(req, Post, fn() { case_workspace.assign(ctx, req, org, cid) })
        ["cases", cid, "tasks"] ->
          only(req, Post, fn() { case_workspace.add_task(ctx, req, org, cid) })
        ["cases", cid, "tasks", tid, "complete"] ->
          only(req, Post, fn() {
            case_workspace.complete_task(ctx, org, cid, tid)
          })
        ["cases", cid, "approvals", aid] ->
          only(req, Post, fn() {
            case_workspace.answer_approval(ctx, req, org, cid, aid)
          })
        ["cases", cid, "link"] ->
          only(req, Post, fn() { case_workspace.link(ctx, req, org, cid) })
        ["cases", cid, "stage"] ->
          only(req, Post, fn() { case_workspace.set_stage(ctx, req, org, cid) })
        ["cases", cid, "decision"] ->
          only(req, Post, fn() { case_workspace.decide(ctx, req, org, cid) })
        ["cases", cid, "budget"] ->
          only(req, Get, fn() { budget_routes.get(ctx, org, cid) })
        ["cases", cid, "budget", "scenarios"] ->
          only(req, Post, fn() { budget_routes.create(ctx, req, org, cid) })
        ["cases", cid, "budget", "scenarios", sid] ->
          only(req, Put, fn() { budget_routes.edit(ctx, req, org, cid, sid) })
        ["cases", cid, "budget", "scenarios", sid, "approve"] ->
          only(req, Post, fn() {
            budget_routes.approve(ctx, req, org, cid, sid)
          })
        ["cases", cid, "budget", "scenarios", sid, "actuals"] ->
          only(req, Post, fn() {
            budget_routes.record_actual(ctx, req, org, cid, sid)
          })
        ["matching", "vocabulary"] ->
          only(req, Get, fn() { matching_routes.vocabulary(org) })
        ["matching"] ->
          only(req, Post, fn() { matching_routes.run(ctx, req, org) })
        ["watchlists"] ->
          case req.method {
            Get -> watchlists.list(ctx, req, org)
            Post -> watchlists.create(ctx, req, org)
            _ -> not_found()
          }
        ["watchlists", wid] ->
          case req.method {
            Get -> watchlists.get(ctx, req, org, wid)
            Patch -> {
              use req <- contract.rerun_on_stale(req)
              watchlists.edit(ctx, req, org, wid)
            }
            _ -> not_found()
          }
        ["watchlists", wid, "history"] ->
          only(req, Get, fn() { watchlists.history(ctx, req, org, wid) })
        ["watchlists", wid, "room"] ->
          only(req, Post, fn() { watchlists.room(ctx, req, org, wid) })
        ["recruitment-briefs"] ->
          case req.method {
            Get -> nobody_missed.list_briefs(ctx, req, org)
            Post -> nobody_missed.create_brief(ctx, req, org)
            _ -> not_found()
          }
        ["recruitment-briefs", bid] ->
          case req.method {
            Get -> nobody_missed.get_brief(ctx, org, bid)
            Patch -> {
              use req <- contract.rerun_on_stale(req)
              nobody_missed.edit_brief(ctx, req, org, bid)
            }
            _ -> not_found()
          }
        ["nobody-missed"] ->
          only(req, Get, fn() { nobody_missed.queue(ctx, req, org) })
        ["nobody-missed", "review"] ->
          only(req, Post, fn() { nobody_missed.review(ctx, req, org) })
        ["nobody-missed", "dismiss"] ->
          only(req, Post, fn() { nobody_missed.dismiss(ctx, req, org) })
        ["nobody-missed", "add-to-room"] ->
          only(req, Post, fn() { nobody_missed.add_to_room(ctx, req, org) })
        ["evaluation-coverage"] ->
          only(req, Get, fn() { nobody_missed.evaluation_coverage(ctx, org) })
        ["second-look"] ->
          only(req, Get, fn() { second_look.list(ctx, req, org) })
        ["second-look", sid] ->
          only(req, Get, fn() { second_look.get(ctx, org, sid) })
        ["second-look", sid, "changes"] ->
          only(req, Get, fn() { second_look.changes(ctx, org, sid) })
        ["second-look", sid, "review"] ->
          only(req, Post, fn() { second_look.review(ctx, req, org, sid) })
        ["second-look", sid, "dismiss"] ->
          only(req, Post, fn() { second_look.dismiss(ctx, req, org, sid) })
        ["second-look", sid, "reopen-room"] ->
          only(req, Post, fn() { second_look.reopen_room(ctx, req, org, sid) })
        ["invoices"] ->
          only(req, Get, fn() { invoices.org_page(ctx, req, org.org.id) })
        ["transitions"] ->
          only(req, Get, fn() { transitions.org_list(ctx, org.org.id) })
        ["transitions", tid, "pack"] ->
          only(req, Get, fn() {
            transitions.org_pack(ctx, req, org, id.transition_case(tid))
          })
        ["audit"] -> only(req, Get, fn() { org_audit.feed(ctx, req, org) })
        ["audit", "export"] ->
          only(req, Get, fn() { audit_export.export(ctx, org) })
        ["staff"] -> only(req, Get, fn() { staff_routes.list(ctx, org) })
        ["tactical"] ->
          case req.method {
            Get -> tactical.get(ctx, org)
            Post -> tactical.save_route(ctx, req, org)
            _ -> not_found()
          }
        ["staff", user_id, "remove"] ->
          only(req, Post, fn() {
            staff_routes.remove(ctx, org, id.org_user(user_id))
          })
        ["invites"] ->
          case req.method {
            Get -> invite_routes.page(ctx, req, org)
            Post -> invite_routes.create(ctx, req, org)
            _ -> not_found()
          }
        ["invites", iid, "revoke"] ->
          only(req, Post, fn() {
            invite_routes.revoke(ctx, req, org, id.org_invite(iid))
          })
        ["onboarding"] ->
          only(req, Get, fn() { invite_routes.onboarding_view(ctx, org) })
        ["sessions"] ->
          only(req, Get, fn() { security_routes.list(ctx, req, org) })
        ["sessions", "revoke"] ->
          only(req, Post, fn() { security_routes.revoke(ctx, req, org) })
        ["security"] ->
          only(req, Put, fn() { security_routes.put(ctx, req, org) })
        ["sso"] ->
          case req.method {
            Get -> sso.view(ctx, org)
            Put -> sso.configure(ctx, req, org)
            _ -> not_found()
          }
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
        ["players", id, "signing"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            signing_routes.legacy_record(ctx, req, org, id)
          })
        ["players", id, "notes"] ->
          only(req, Post, fn() {
            discovery.add_note(ctx, req, org, id.player(id))
          })
        ["players", id, "morelike"] ->
          only(req, Get, fn() { discovery.more_like(ctx, org, id.player(id)) })
        ["players", id, "proofpack"] ->
          only(req, Get, fn() { discovery.proof_pack(ctx, org, id.player(id)) })
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
            passport_routes.club_submit(ctx, req, org, id.player(id))
          })
        ["players", id, "passport"] ->
          only(req, Get, fn() {
            passport_routes.org_passport(ctx, org, id.player(id))
          })
        ["evidence", eid, "corroborate"] ->
          only(req, Post, fn() {
            passport_routes.corroborate(
              ctx,
              req,
              org,
              id.scouting_evidence(eid),
            )
          })
        ["evidence", eid, "dispute"] ->
          only(req, Post, fn() {
            passport_routes.org_dispute(
              ctx,
              req,
              org,
              id.scouting_evidence(eid),
            )
          })
        ["coaches"] ->
          case req.method {
            Get -> coaches.list_for_org(ctx, org)
            Post -> coaches.create(ctx, req, org)
            _ -> not_found()
          }
        ["coaches", aid, "end"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            coaches.close(
              ctx,
              req,
              org,
              id.coach_affiliation(aid),
              affiliation_row.Ended,
            )
          })
        ["coaches", aid, "revoke"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            coaches.close(
              ctx,
              req,
              org,
              id.coach_affiliation(aid),
              affiliation_row.Revoked,
            )
          })
        ["squad", "invite"] ->
          only(req, Post, fn() { squad_invites.invite(ctx, req, org) })
        ["players", id, "evidence-gaps"] ->
          only(req, Get, fn() { evidence_gaps.gaps(ctx, org, id.player(id)) })
        ["box-cam", "assignments"] ->
          case req.method {
            Get -> box_training.org_assignments(ctx, req, org)
            Post -> box_training.create_assignment(ctx, req, org)
            _ -> not_found()
          }
        ["box-cam", "assignments", aid, "cancel"] ->
          only(req, Post, fn() {
            box_training.cancel_assignment(
              ctx,
              req,
              org,
              id.box_assignment(aid),
            )
          })
        ["box-cam", "challenges"] ->
          case req.method {
            Get -> box_training.org_challenges(ctx, req, org)
            Post -> box_training.create_challenge(ctx, req, org)
            _ -> not_found()
          }
        ["combine", "protocols"] ->
          only(req, Get, fn() { combine_routes.org_protocols(ctx) })
        ["combine", "players", id] ->
          only(req, Get, fn() {
            combine_routes.player_results(ctx, org, id.player(id))
          })
        ["combine", "requests"] ->
          case req.method {
            Get -> combine_routes.org_requests(ctx, req, org)
            Post -> combine_routes.create_requests(ctx, req, org)
            _ -> not_found()
          }
        ["combine", "requests", rid, "cancel"] ->
          only(req, Post, fn() {
            combine_routes.cancel_request(
              ctx,
              req,
              org,
              id.combine_request(rid),
            )
          })
        ["combine", "compare"] ->
          only(req, Get, fn() { combine_routes.compare(ctx, req, org) })
        ["players", pid, "objectives"] ->
          only(req, Get, fn() { objectives.org_list(ctx, org, id.player(pid)) })
        ["followups"] ->
          only(req, Get, fn() { follow_ups.org_list(ctx, req, org) })
        ["followups", fid, "report"] ->
          only(req, Post, fn() {
            follow_ups.report(ctx, req, org, id.follow_up(fid))
          })
        ["reassessments", rid, "outcome"] ->
          only(req, Post, fn() {
            objectives.outcome(ctx, req, org, id.reassessment(rid))
          })
        ["players", id, "trust-profile"] ->
          only(req, Get, fn() { trust.org_view(ctx, org, id.player(id)) })
        ["players", id, "football-passport"] ->
          only(req, Get, fn() {
            football_passport.org_view(ctx, org, id.player(id))
          })
        ["players", pid, "football-passport", "achievements", aid, "confirm"] ->
          only(req, Post, fn() {
            football_passport.confirm_achievement(
              ctx,
              org,
              id.player(pid),
              id.achievement(aid),
            )
          })
        ["football-passports"] ->
          only(req, Get, fn() { football_passport.batch(ctx, req, org) })
        ["passport", "shared", token] ->
          only(req, Get, fn() { sharing.open_recruitment(ctx, org, token) })
        ["trust-summaries"] ->
          only(req, Get, fn() { trust.org_summaries(ctx, req, org) })
        ["players", pid, "assessment-compare"] ->
          only(req, Get, fn() { assessments.compare(ctx, org, id.player(pid)) })
        ["assessments"] ->
          case req.method {
            Get -> assessments.list_for(ctx, req, org)
            Post -> assessments.create(ctx, req, org)
            _ -> not_found()
          }
        ["assessments", aid] ->
          only(req, Put, fn() {
            use req <- contract.rerun_on_stale(req)
            assessments.edit(ctx, req, org, id.assessment(aid))
          })
        ["assessments", aid, "submit"] ->
          only(req, Post, fn() {
            assessments.submit(ctx, org, id.assessment(aid))
          })
        ["assessments", aid, "publish-feedback"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            assessments.publish_feedback(ctx, req, org, id.assessment(aid))
          })
        ["media", mid, "segments"] ->
          only(req, Post, fn() { video.create(ctx, req, org, id.media(mid)) })
        ["segments"] -> only(req, Get, fn() { video.list_for(ctx, req, org) })
        ["segments", sid] ->
          only(req, Get, fn() { video.one(ctx, org, id.segment(sid)) })
        ["playlists"] ->
          case req.method {
            Get -> video.playlists(ctx, org)
            Post -> video.create_playlist(ctx, req, org)
            _ -> not_found()
          }
        ["playlists", pid, "segments"] ->
          only(req, Post, fn() {
            video.add_segment(ctx, req, org, id.playlist(pid))
          })
        ["shortlist"] -> only(req, Get, fn() { discovery.shortlist(ctx, org) })
        ["review-queue"] ->
          only(req, Get, fn() { review_queue.review_queue(ctx, org) })
        ["review-queue", pid, "later"] ->
          only(req, Post, fn() {
            review_queue.defer(ctx, req, org, id.player(pid))
          })
        ["exposure", "impressions"] ->
          only(req, Post, fn() { exposure.impressions(ctx, req, org) })
        ["exposure", "report"] ->
          only(req, Get, fn() { exposure.report(ctx, org) })
        ["discovery-rotation"] ->
          only(req, Get, fn() { exposure.rotation(ctx, org) })
        ["decision-review"] ->
          only(req, Get, fn() { exposure.decision_review(ctx, org) })
        ["assessment-templates"] ->
          case req.method {
            Get -> assessments.templates(ctx)
            Post -> assessments.publish_template(ctx, req, org)
            _ -> not_found()
          }
        ["calibration"] ->
          case req.method {
            Get -> calibration.list_for(ctx, req, org)
            Post -> calibration.create(ctx, req, org)
            _ -> not_found()
          }
        ["calibration", cid] ->
          only(req, Get, fn() {
            calibration.get(ctx, org, id.calibration_session(cid))
          })
        ["calibration", cid, "submit"] ->
          only(req, Post, fn() {
            calibration.submit(ctx, req, org, id.calibration_session(cid))
          })
        ["calibration", cid, "close"] ->
          only(req, Post, fn() {
            calibration.close(ctx, req, org, id.calibration_session(cid))
          })
        ["calibration", cid, "notes"] ->
          only(req, Post, fn() {
            calibration.add_note(ctx, req, org, id.calibration_session(cid))
          })
        ["evidence-gaps", gid, "request"] ->
          only(req, Post, fn() {
            evidence_gaps.request_route(
              ctx,
              req,
              org,
              id.evidence_suggestion(gid),
            )
          })
        ["evidence-gaps", gid, "dismiss"] ->
          only(req, Post, fn() {
            evidence_gaps.set_status_route(
              ctx,
              req,
              org,
              id.evidence_suggestion(gid),
              suggestion_row.Dismissed,
            )
          })
        ["evidence-gaps", gid, "reviewed"] ->
          only(req, Post, fn() {
            evidence_gaps.set_status_route(
              ctx,
              req,
              org,
              id.evidence_suggestion(gid),
              suggestion_row.Reviewed,
            )
          })
        ["coverage", "fixtures"] ->
          case req.method {
            Get -> coverage.list_fixtures(ctx, req, org)
            Post -> coverage.create_fixture(ctx, req, org)
            _ -> not_found()
          }
        ["coverage-plans"] ->
          case req.method {
            Get -> coverage.list_plans(ctx, org)
            Post -> coverage.create_plan(ctx, req, org)
            _ -> not_found()
          }
        ["coverage", "assignments"] ->
          case req.method {
            Get -> coverage.list_assignments(ctx, req, org)
            Post -> coverage.create_assignment(ctx, req, org)
            _ -> not_found()
          }
        ["coverage", "assignments", aid, "complete"] ->
          only(req, Post, fn() {
            coverage.complete(ctx, req, org, id.coverage_assignment(aid))
          })
        ["coverage", "assignments", aid, "cancel"] ->
          only(req, Post, fn() {
            coverage.cancel(ctx, req, org, id.coverage_assignment(aid))
          })
        ["coverage", "suggestions"] ->
          only(req, Get, fn() { coverage.suggestions(ctx, org) })
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
              notification_targets.target,
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
        ["webhooks"] ->
          case req.method {
            Get -> webhooks.list_endpoints(ctx, org)
            Post -> webhooks.create(ctx, req, org)
            _ -> not_found()
          }
        ["webhooks", wid, "rotate"] ->
          only(req, Post, fn() { webhooks.rotate(ctx, req, org, wid) })
        ["webhooks", wid, "deactivate"] ->
          only(req, Post, fn() { webhooks.deactivate(ctx, req, org, wid) })
        ["webhooks", wid, "deliveries"] ->
          only(req, Get, fn() { webhooks.deliveries(ctx, org, wid) })
        ["imports"] ->
          case req.method {
            Get -> imports.page(ctx, req, org)
            Post -> imports.validate_upload(ctx, req, org)
            _ -> not_found()
          }
        ["imports", "template"] -> only(req, Get, imports.template)
        ["imports", bid] -> only(req, Get, fn() { imports.show(ctx, org, bid) })
        ["imports", bid, "commit"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            imports.commit(ctx, req, org, bid)
          })
        ["imports", bid, "reverse"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            imports.reverse(ctx, req, org, bid)
          })
        ["prospects"] ->
          only(req, Get, fn() { imports.prospects(ctx, req, org) })
        ["identity-reviews"] ->
          only(req, Get, fn() { imports.open_reviews(ctx, org) })
        ["identity-reviews", rid, "resolve"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            imports.resolve(ctx, req, org, rid)
          })
        ["api-keys"] ->
          case req.method {
            Get -> api_keys.list_keys(ctx, org)
            Post -> api_keys.create(ctx, req, org)
            _ -> not_found()
          }
        ["api-keys", kid, "revoke"] ->
          only(req, Post, fn() { api_keys.revoke(ctx, req, org, kid) })
        ["connectors"] -> only(req, Get, fn() { api_keys.connector_list(ctx) })
        ["support"] ->
          case req.method {
            Get -> support.org_page(ctx, req, org)
            Post -> support.create(ctx, req, org)
            _ -> not_found()
          }
        ["support", tid, "approve-access"] ->
          only(req, Post, fn() {
            support.approve_access(ctx, req, org, id.ticket(tid))
          })
        ["groups"] -> only(req, Get, fn() { group_routes.org_list(ctx, org) })
        ["groups", gid, "invite"] ->
          only(req, Post, fn() {
            group_routes.invite(ctx, req, org, id.group(gid))
          })
        ["groups", gid, "accept"] ->
          only(req, Post, fn() { group_routes.accept(ctx, org, id.group(gid)) })
        ["groups", gid, "leave"] ->
          only(req, Post, fn() { group_routes.leave(ctx, org, id.group(gid)) })
        ["groups", gid, "templates"] ->
          only(req, Post, fn() {
            group_routes.share_template(ctx, req, org, id.group(gid))
          })
        ["groups", gid, "programmes"] ->
          only(req, Post, fn() {
            group_routes.add_programme(ctx, req, org, id.group(gid))
          })
        ["groups", gid, "grants", "preview"] ->
          only(req, Post, fn() {
            group_routes.preview(ctx, req, org, id.group(gid))
          })
        ["groups", gid, "grants"] ->
          only(req, Post, fn() {
            group_routes.create_grant(ctx, req, org, id.group(gid))
          })
        ["groups", gid, "report"] ->
          only(req, Get, fn() { group_routes.report(ctx, org, id.group(gid)) })
        ["grants"] ->
          only(req, Get, fn() { group_routes.grants(ctx, req, org) })
        ["grants", "counts"] ->
          only(req, Get, fn() { group_routes.grant_counts(ctx, org) })
        ["grants", gid, "revoke"] ->
          only(req, Post, fn() {
            group_routes.revoke(ctx, org, id.group_grant(gid))
          })
        ["shared", gid] ->
          only(req, Get, fn() {
            group_routes.shared(ctx, org, id.group_grant(gid))
          })
        ["squad"] ->
          case req.method {
            Get -> grassroots_club.squad(ctx, org)
            Post -> grassroots_club.add_to_squad(ctx, req, org)
            _ -> not_found()
          }
        ["matchday"] ->
          only(req, Post, fn() { grassroots_club.log_matchday(ctx, req, org) })
        ["open-trials"] ->
          only(req, Post, fn() {
            grassroots_club.post_open_trial(ctx, req, org)
          })
        ["opportunities"] ->
          case req.method {
            Get -> opportunities.list_for_org(ctx, req, org)
            Post -> opportunities.create(ctx, req, org)
            _ -> not_found()
          }
        ["campaigns"] ->
          case req.method {
            Get -> campaigns.list_for_org(ctx, req, org)
            Post -> campaigns.create(ctx, req, org)
            _ -> not_found()
          }
        ["campaigns", cid, "review-queue"] ->
          only(req, Get, fn() {
            campaigns.review_queue(ctx, org, id.campaign(cid))
          })
        ["campaign-attempts", aid, "review"] ->
          only(req, Post, fn() {
            campaigns.review(ctx, req, org, id.campaign_attempt(aid))
          })
        ["opportunities", oid, "applications"] ->
          only(req, Get, fn() {
            applies.list_for_opportunity(ctx, req, org, id.opportunity(oid))
          })
        ["opportunities", oid, "close"] ->
          only(req, Post, fn() {
            applies.close(ctx, req, org, id.opportunity(oid))
          })
        ["applications", aid, "outcome"] ->
          only(req, Post, fn() {
            applies.outcome(ctx, req, org, id.application(aid))
          })
        ["applications", aid, "suitability"] ->
          only(req, Get, fn() {
            suitability.for_club(ctx, org, id.application(aid))
          })
        ["opportunities", oid, "structured-requirements"] ->
          only(req, Put, fn() {
            suitability.set_structured(ctx, req, org, id.opportunity(oid))
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
        ["compliance", "consents"] ->
          only(req, Get, fn() { compliance.club_consents(ctx, org) })
        ["compliance", "consents", cid, action] -> {
          let act = case action {
            "grant" -> Ok(compliance.GrantIt)
            "decline" -> Ok(compliance.DeclineIt)
            "revoke" -> Ok(compliance.RevokeIt)
            _ -> Error(Nil)
          }
          case act {
            Ok(act) ->
              only(req, Post, fn() {
                use req <- contract.rerun_on_stale(req)
                compliance.club_answer(ctx, req, org, cid, act)
              })
            Error(Nil) -> not_found()
          }
        }
        ["transactions"] ->
          only(req, Get, fn() { party_lanes.club_list(ctx, req, org) })
        ["transactions", tid] ->
          only(req, Get, fn() { party_lanes.club_get(ctx, org, tid) })
        ["transactions", tid, "confirm"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            party_lanes.club_confirm(ctx, req, org, tid)
          })
        ["transactions", tid, "notes"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            party_lanes.club_note(ctx, req, org, tid)
          })
        ["transactions", tid, "timeline"] ->
          only(req, Get, fn() { party_lanes.club_timeline(ctx, org, tid) })
        ["transactions", tid, "documents"] ->
          case req.method {
            Get -> party_lanes.club_documents(ctx, org, tid)
            Post -> {
              use req <- contract.rerun_on_stale(req)
              party_lanes.club_add_document(ctx, req, org, tid)
            }
            _ -> not_found()
          }
        ["transactions", tid, "documents", did, "reference"] ->
          only(req, Get, fn() {
            party_lanes.club_document_reference(ctx, org, tid, did)
          })
        ["transactions", tid, "messages", "link"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            party_lanes.club_link_thread(ctx, req, org, tid)
          })
        ["transactions", tid, "links"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            party_lanes.club_link_trial(ctx, req, org, tid)
          })
        _ -> not_found()
      }
    }
    ["player", ..rest] -> {
      use player <- access.player_session(ctx, req)
      case rest {
        ["development", ..path] ->
          hub_routes.handle(ctx, req, hub_routes.AsPlayer(player), path)
        ["passport"] ->
          only(req, Get, fn() { passport_routes.player_passport(ctx, player) })
        ["feedback"] ->
          only(req, Get, fn() { assessments.player_feedback(ctx, player) })
        ["evidence"] ->
          only(req, Post, fn() {
            passport_routes.player_submit(ctx, req, player)
          })
        ["evidence", eid, "correct"] ->
          only(req, Post, fn() {
            passport_routes.player_correct(
              ctx,
              req,
              player,
              id.scouting_evidence(eid),
            )
          })
        ["evidence", eid, "dispute"] ->
          only(req, Post, fn() {
            passport_routes.player_dispute(
              ctx,
              req,
              player,
              id.scouting_evidence(eid),
            )
          })
        ["squad-invites"] ->
          only(req, Get, fn() { squad_invites.player_list(ctx, player) })
        ["squad-invites", iid, "respond"] ->
          only(req, Post, fn() {
            squad_invites.player_respond(ctx, req, player, id.squad_invite(iid))
          })
        ["vouches", "request"] ->
          only(req, Post, fn() { vouches.player_request(ctx, req, player) })
        ["inbox"] ->
          only(req, Get, fn() { request_routes.player_inbox(ctx, req, player) })
        ["football-passport"] ->
          only(req, Get, fn() { football_passport.player_view(ctx, player) })
        ["football-passport", "prefs"] ->
          only(req, Patch, fn() {
            football_passport.player_prefs(ctx, req, player)
          })
        ["football-passport", "career"] ->
          only(req, Post, fn() {
            football_passport.player_career(ctx, req, player)
          })
        ["football-passport", "career", eid, "withdraw"] ->
          only(req, Post, fn() {
            football_passport.withdraw_career(ctx, player, id.career_entry(eid))
          })
        ["football-passport", "achievements"] ->
          only(req, Post, fn() {
            football_passport.player_achievement(ctx, req, player)
          })
        ["football-passport", "achievements", aid, "withdraw"] ->
          only(req, Post, fn() {
            football_passport.withdraw_achievement(
              ctx,
              player,
              id.achievement(aid),
            )
          })
        ["football-passport", "corrections"] ->
          only(req, Post, fn() {
            football_passport.player_correction(ctx, req, player)
          })
        ["football-passport", "shares"] ->
          case req.method {
            Get -> sharing.player_list(ctx, player)
            Post -> sharing.player_create(ctx, req, player)
            _ -> not_found()
          }
        ["football-passport", "shares", sid, "revoke"] ->
          only(req, Post, fn() {
            sharing.player_revoke(ctx, player, id.passport_share(sid))
          })
        ["insights"] -> only(req, Get, fn() { insights.show(ctx, player) })
        ["exposure"] ->
          only(req, Get, fn() { exposure.player_view(ctx, player) })
        ["journeys"] ->
          only(req, Get, fn() { case_routes.player_journeys(ctx, req, player) })
        ["signings"] ->
          only(req, Get, fn() { signing_routes.player_list(ctx, req, player) })
        ["signings", sid] ->
          only(req, Get, fn() {
            signing_routes.player_get(ctx, req, player, id.signing_package(sid))
          })
        ["signings", sid, "document"] ->
          only(req, Get, fn() {
            signing_routes.player_document(
              ctx,
              req,
              player,
              id.signing_package(sid),
            )
          })
        ["signings", sid, "complete"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            signing_routes.player_complete(
              ctx,
              req,
              player,
              id.signing_package(sid),
            )
          })
        ["box-cam", "sessions", sid, "cv", action] -> {
          let sid = id.box_session(sid)
          only(req, Post, fn() {
            case action {
              "begin" -> cv_stub.begin(ctx, req, player, sid)
              "frames" -> cv_stub.frames(ctx, req, player, sid)
              "finalize" -> cv_stub.finalize(ctx, req, player, sid)
              "cancel" -> cv_stub.cancel(ctx, req, player, sid)
              _ -> not_found()
            }
          })
        }
        ["box-cam", "cv", "ready-check"] ->
          only(req, Post, fn() { cv_stub.ready_check(ctx, req, player) })
        ["box-cam", "prefs"] ->
          case req.method {
            Get -> box_prefs.show(ctx, player)
            Patch -> box_prefs.update(ctx, req, player)
            _ -> not_found()
          }
        ["box-cam", "drills"] ->
          only(req, Get, fn() { box_session_routes.drills(ctx) })
        ["box-cam", "dashboard"] ->
          only(req, Get, fn() { box_session_routes.dashboard(ctx, player) })
        ["box-cam", "sessions"] ->
          case req.method {
            Get -> box_session_routes.list(ctx, player)
            Post -> box_session_routes.create(ctx, req, player)
            _ -> not_found()
          }
        ["box-cam", "sessions", sid] ->
          only(req, Get, fn() {
            box_session_routes.show(ctx, player, id.box_session(sid))
          })
        ["box-cam", "sessions", sid, action] -> {
          let sid = id.box_session(sid)
          only(req, Post, fn() {
            case action {
              "start" -> box_session_routes.start(ctx, req, player, sid)
              "events" -> box_session_routes.events(ctx, req, player, sid)
              "complete" -> box_session_routes.complete(ctx, req, player, sid)
              "cancel" -> box_session_routes.cancel(ctx, req, player, sid)
              "note" -> box_session_routes.note(ctx, req, player, sid)
              "dispute" -> box_training.player_dispute(ctx, req, player, sid)
              _ -> not_found()
            }
          })
        }
        ["box-cam", "assignments"] ->
          only(req, Get, fn() { box_training.player_assignments(ctx, player) })
        ["combine"] -> only(req, Get, fn() { combine_routes.mine(ctx, player) })
        ["combine", "protocols"] ->
          only(req, Get, fn() { combine_routes.player_protocols(ctx) })
        ["combine", "card"] ->
          only(req, Get, fn() { combine_routes.card(ctx, player) })
        ["combine", "requests"] ->
          only(req, Get, fn() { combine_routes.player_requests(ctx, player) })
        ["combine", "attempts"] ->
          case req.method {
            Get -> combine_routes.attempts(ctx, player)
            Post -> combine_routes.create_attempt(ctx, req, player)
            _ -> not_found()
          }
        ["combine", "attempts", aid] ->
          only(req, Get, fn() {
            combine_routes.attempt(ctx, player, id.combine_attempt(aid))
          })
        ["combine", "attempts", aid, action] -> {
          let aid = id.combine_attempt(aid)
          only(req, Post, fn() {
            case action {
              "calibrate" -> combine_routes.calibrate(ctx, req, player, aid)
              "complete" -> combine_routes.complete(ctx, req, player, aid)
              "cancel" -> combine_routes.cancel(ctx, req, player, aid)
              _ -> not_found()
            }
          })
        }
        ["box-cam", "assignments", aid, "accept"] ->
          only(req, Post, fn() {
            box_training.player_accept(ctx, req, player, id.box_assignment(aid))
          })
        ["box-cam", "challenges"] ->
          only(req, Get, fn() { box_training.player_challenges(ctx, player) })
        ["box-cam", "challenges", cid, "join"] ->
          only(req, Post, fn() {
            box_training.player_join(ctx, req, player, cid)
          })
        ["agent", "consents"] ->
          only(req, Get, fn() { compliance.player_consents(ctx, player) })
        ["agent", "consents", cid, action] -> {
          let act = case action {
            "grant" -> Ok(compliance.GrantIt)
            "decline" -> Ok(compliance.DeclineIt)
            "revoke" -> Ok(compliance.RevokeIt)
            _ -> Error(Nil)
          }
          case act {
            Ok(act) ->
              only(req, Post, fn() {
                use req <- contract.rerun_on_stale(req)
                compliance.player_answer(ctx, req, player, cid, act)
              })
            Error(Nil) -> not_found()
          }
        }
        ["transactions"] ->
          only(req, Get, fn() { party_lanes.player_list(ctx, player) })
        ["transactions", tid] ->
          only(req, Get, fn() { party_lanes.player_get(ctx, player, tid) })
        ["transactions", tid, "confirm"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            party_lanes.player_confirm(ctx, req, player, tid)
          })
        ["transactions", tid, "timeline"] ->
          only(req, Get, fn() { party_lanes.player_timeline(ctx, player, tid) })
        ["transactions", tid, "documents"] ->
          case req.method {
            Get -> party_lanes.player_documents(ctx, player, tid)
            Post -> {
              use req <- contract.rerun_on_stale(req)
              party_lanes.player_add_document(ctx, req, player, tid)
            }
            _ -> not_found()
          }
        ["transactions", tid, "documents", did, "reference"] ->
          only(req, Get, fn() {
            party_lanes.player_document_reference(ctx, player, tid, did)
          })
        ["agent", "relationships"] ->
          only(req, Get, fn() { agent.my_agent(ctx, player) })
        ["agent", "shared-opportunities"] ->
          only(req, Get, fn() { integration_routes.player_shared(ctx, player) })
        ["agent", "relationships", rid, "confirm"] ->
          only(req, Post, fn() {
            agent.answer(ctx, req, player, id.agreement(rid), agent.Confirm)
          })
        ["agent", "relationships", rid, "decline"] ->
          only(req, Post, fn() {
            agent.answer(ctx, req, player, id.agreement(rid), agent.Decline)
          })
        ["agent", "relationships", rid, "terminate"] ->
          only(req, Post, fn() {
            agent.answer(ctx, req, player, id.agreement(rid), agent.End)
          })
        ["agent", "relationships", rid, "dispute"] ->
          only(req, Post, fn() {
            agent.answer(ctx, req, player, id.agreement(rid), agent.Dispute)
          })
        ["agent", "relationships", rid, "sharing"] ->
          only(req, Patch, fn() {
            use req <- contract.rerun_on_stale(req)
            agent.sharing(ctx, req, player, id.agreement(rid))
          })
        ["account"] ->
          only(req, Delete, fn() { erasure.delete_account(ctx, player) })
        ["opportunity-board"] ->
          only(req, Get, fn() { board_routes.player_board(ctx, req, player) })
        ["opportunities", oid, "apply"] ->
          only(req, Post, fn() {
            applies.player_apply(ctx, req, player, id.opportunity(oid))
          })
        ["preferences"] ->
          case req.method {
            Get -> suitability.show(ctx, player)
            Put -> suitability.update(ctx, req, player)
            _ -> not_found()
          }
        ["suitability", "share"] ->
          only(req, Post, fn() { suitability.player_share(ctx, req, player) })
        ["suitability", oid] ->
          only(req, Get, fn() {
            suitability.player_verdicts(ctx, player, id.opportunity(oid))
          })
        ["campaigns"] ->
          only(req, Get, fn() { campaigns.player_list(ctx, player) })
        ["campaigns", cid, "submit"] ->
          only(req, Post, fn() {
            campaigns.player_submit(ctx, req, player, id.campaign(cid))
          })
        ["drill-guidance"] ->
          only(req, Get, fn() { drill_guidance.player_list(ctx) })
        ["objectives"] ->
          case req.method {
            Get -> objectives.player_list(ctx, player)
            Post -> objectives.player_create(ctx, req, player)
            _ -> not_found()
          }
        ["followups"] ->
          only(req, Get, fn() { follow_ups.player_list(ctx, player) })
        ["followups", fid, "respond"] ->
          only(req, Post, fn() {
            follow_ups.player_respond(ctx, req, player, id.follow_up(fid))
          })
        ["benchmarks"] ->
          only(req, Get, fn() { benchmarks.player(ctx, player) })
        ["football-category"] ->
          only(req, Post, fn() {
            follow_ups.football_category(ctx, req, player)
          })
        ["objectives", oid, "progress"] ->
          only(req, Post, fn() {
            objectives.progress(ctx, req, player, id.objective(oid))
          })
        ["objectives", oid, "share"] ->
          only(req, Post, fn() {
            objectives.player_share(ctx, req, player, id.objective(oid))
          })
        ["objectives", oid, "reassessment"] ->
          only(req, Post, fn() {
            objectives.player_reassessment(ctx, req, player, id.objective(oid))
          })
        ["applications"] ->
          only(req, Get, fn() { applies.player_list(ctx, player) })
        ["applications", aid, "withdraw"] ->
          only(req, Post, fn() {
            applies.player_withdraw(ctx, req, player, id.application(aid))
          })
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
              id.offer(oid),
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
              id.offer(oid),
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
              id.offer(oid),
              False,
            )
          })
        ["offers", oid, "share-agent"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            offer_routes.share_agent(ctx, req, player, id.offer(oid))
          })
        ["offers", oid, "documents", doc] ->
          only(req, Get, fn() {
            offer_routes.document(
              ctx,
              req,
              offer_routes.PlayerRecipient(player),
              id.offer(oid),
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
        ["trust-profile", "explain"] ->
          only(req, Get, fn() { trust.player_explain(ctx, player) })
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
              notification_targets.target,
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
          case req.method {
            Get -> transitions.owner_list(ctx, transitions.PlayerOwner(player))
            Post -> transitions.player_open(ctx, req, player)
            _ -> not_found()
          }
        ["transitions", id, "withdraw"] ->
          only(req, Post, fn() {
            transitions.withdraw(
              ctx,
              req,
              transitions.PlayerOwner(player),
              id.transition_case(id),
            )
          })
        ["transitions", id, "place"] ->
          only(req, Post, fn() {
            transitions.place(
              ctx,
              req,
              transitions.PlayerOwner(player),
              id.transition_case(id),
            )
          })
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
        ["development", ..path] ->
          hub_routes.handle(ctx, req, hub_routes.AsGuardian(guardian), path)
        ["children", cid, "campaigns"] ->
          only(req, Get, fn() {
            campaigns.guardian_list(ctx, guardian, id.player(cid))
          })
        ["children", cid, "campaigns", camp, "submit"] ->
          only(req, Post, fn() {
            campaigns.guardian_submit(
              ctx,
              req,
              guardian,
              id.player(cid),
              id.campaign(camp),
            )
          })
        ["children", cid, "preferences"] ->
          case req.method {
            Get -> suitability.child_show(ctx, guardian, id.player(cid))
            Put -> suitability.child_update(ctx, req, guardian, id.player(cid))
            _ -> not_found()
          }
        ["children", cid, "suitability", "share"] ->
          only(req, Post, fn() {
            suitability.child_share(ctx, req, guardian, id.player(cid))
          })
        ["children", cid, "suitability", oid] ->
          only(req, Get, fn() {
            suitability.child_verdicts(
              ctx,
              guardian,
              id.player(cid),
              id.opportunity(oid),
            )
          })
        ["children", cid, "opportunities", oid, "apply"] ->
          only(req, Post, fn() {
            applies.guardian_apply(
              ctx,
              req,
              guardian,
              id.player(cid),
              id.opportunity(oid),
            )
          })
        ["applications"] ->
          only(req, Get, fn() { applies.guardian_list(ctx, guardian) })
        ["applications", aid, "withdraw"] ->
          only(req, Post, fn() {
            applies.guardian_withdraw(ctx, req, guardian, id.application(aid))
          })
        ["children", cid, "box-cam", "sessions"] ->
          only(req, Get, fn() {
            box_session_routes.child_list(ctx, guardian, id.player(cid))
          })
        ["children", cid, "box-cam", "dashboard"] ->
          only(req, Get, fn() {
            box_session_routes.child_dashboard(ctx, guardian, id.player(cid))
          })
        ["children", cid, "box-cam", "sessions", sid, "dispute"] ->
          only(req, Post, fn() {
            box_training.child_dispute(
              ctx,
              req,
              guardian,
              id.player(cid),
              id.box_session(sid),
            )
          })
        ["children", cid, "box-cam", "assignments"] ->
          only(req, Get, fn() {
            box_training.child_assignments(ctx, guardian, id.player(cid))
          })
        ["children", cid, "box-cam", "assignments", aid, "accept"] ->
          only(req, Post, fn() {
            box_training.child_accept(
              ctx,
              req,
              guardian,
              id.player(cid),
              id.box_assignment(aid),
            )
          })
        ["children", cid, "box-cam", "challenges", chid, "join"] ->
          only(req, Post, fn() {
            box_training.child_join(ctx, req, guardian, id.player(cid), chid)
          })
        ["children", cid, "trust-profile"] ->
          only(req, Get, fn() {
            trust.guardian_view(ctx, guardian, id.player(cid))
          })
        ["children", cid, "combine"] ->
          only(req, Get, fn() {
            combine_routes.child_combine(ctx, guardian, id.player(cid))
          })
        ["children", cid, "combine", "requests"] ->
          only(req, Get, fn() {
            combine_routes.child_requests(ctx, guardian, id.player(cid))
          })
        ["children", cid, "box-cam", "prefs"] ->
          only(req, Patch, fn() {
            box_prefs.update_child(ctx, req, guardian, id.player(cid))
          })
        ["children", cid, "football-passport"] ->
          only(req, Get, fn() {
            football_passport.guardian_view(ctx, guardian, id.player(cid))
          })
        ["children", cid, "football-passport", "prefs"] ->
          only(req, Patch, fn() {
            football_passport.guardian_prefs(ctx, req, guardian, id.player(cid))
          })
        ["children", cid, "football-passport", "career"] ->
          only(req, Post, fn() {
            football_passport.guardian_career(
              ctx,
              req,
              guardian,
              id.player(cid),
            )
          })
        ["children", cid, "football-passport", "achievements"] ->
          only(req, Post, fn() {
            football_passport.guardian_achievement(
              ctx,
              req,
              guardian,
              id.player(cid),
            )
          })
        ["children", cid, "football-passport", "corrections"] ->
          only(req, Post, fn() {
            football_passport.guardian_correction(
              ctx,
              req,
              guardian,
              id.player(cid),
            )
          })
        ["children", cid, "football-passport", "shares"] ->
          case req.method {
            Get -> sharing.guardian_list(ctx, guardian, id.player(cid))
            Post -> sharing.guardian_create(ctx, req, guardian, id.player(cid))
            _ -> not_found()
          }
        ["children", cid, "football-passport", "shares", sid, "revoke"] ->
          only(req, Post, fn() {
            sharing.guardian_revoke(
              ctx,
              guardian,
              id.player(cid),
              id.passport_share(sid),
            )
          })
        ["children", cid, "passport"] ->
          only(req, Get, fn() {
            passport_routes.guardian_passport(ctx, guardian, id.player(cid))
          })
        ["followups"] ->
          only(req, Get, fn() { follow_ups.guardian_list(ctx, guardian) })
        ["followups", fid, "respond"] ->
          only(req, Post, fn() {
            follow_ups.guardian_respond(ctx, req, guardian, id.follow_up(fid))
          })
        ["children", cid, "objectives"] ->
          case req.method {
            Get -> objectives.guardian_list(ctx, guardian, id.player(cid))
            Post ->
              objectives.guardian_create(ctx, req, guardian, id.player(cid))
            _ -> not_found()
          }
        ["objectives", oid, "share"] ->
          only(req, Post, fn() {
            objectives.guardian_share(ctx, req, guardian, id.objective(oid))
          })
        ["objectives", oid, "reassessment"] ->
          only(req, Post, fn() {
            objectives.guardian_reassessment(
              ctx,
              req,
              guardian,
              id.objective(oid),
            )
          })
        ["children", cid, "feedback"] ->
          only(req, Get, fn() {
            assessments.child_feedback(ctx, guardian, id.player(cid))
          })
        ["children", cid, "evidence"] ->
          only(req, Post, fn() {
            passport_routes.guardian_submit(ctx, req, guardian, id.player(cid))
          })
        ["children", cid, "vouches", "request"] ->
          only(req, Post, fn() {
            vouches.guardian_request(ctx, req, guardian, id.player(cid))
          })
        ["squad-invites"] ->
          only(req, Get, fn() { squad_invites.guardian_list(ctx, guardian) })
        ["squad-invites", iid, "respond"] ->
          only(req, Post, fn() {
            squad_invites.guardian_respond(
              ctx,
              req,
              guardian,
              id.squad_invite(iid),
            )
          })
        ["verification", "org", id] ->
          only(req, Get, fn() { personal.public_org(ctx, id.org(id)) })
        ["invites", "accept"] ->
          only(req, Post, fn() { invites.guardian_accept(ctx, req, guardian) })
        ["signings"] ->
          only(req, Get, fn() { signing_routes.guardian_list(guardian) })
        ["signings", _] -> only(req, Get, signing_routes.guardian_get)
        ["signings", _, "document"] ->
          only(req, Get, signing_routes.guardian_document)
        ["signings", _, "complete"] ->
          only(req, Post, signing_routes.guardian_complete)
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
              id.offer(oid),
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
              id.offer(oid),
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
              id.offer(oid),
              False,
            )
          })
        ["offers", oid, "documents", doc] ->
          only(req, Get, fn() {
            offer_routes.document(
              ctx,
              req,
              offer_routes.GuardianRecipient(guardian),
              id.offer(oid),
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
              notification_targets.target,
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
        ["children-transitions"] ->
          only(req, Get, fn() {
            transitions.owner_list(ctx, transitions.GuardianOwner(guardian))
          })
        ["children-transitions", id, "withdraw"] ->
          only(req, Post, fn() {
            transitions.withdraw(
              ctx,
              req,
              transitions.GuardianOwner(guardian),
              id.transition_case(id),
            )
          })
        ["children-transitions", id, "place"] ->
          only(req, Post, fn() {
            transitions.place(
              ctx,
              req,
              transitions.GuardianOwner(guardian),
              id.transition_case(id),
            )
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
    ["ts", ..rest] -> {
      use reviewer <- compliance.reviewer_session(ctx, req)
      case rest {
        ["compliance", "reviews"] ->
          only(req, Get, fn() { compliance.review_queue(ctx, req, reviewer) })
        ["me"] -> only(req, Get, fn() { compliance.me(reviewer) })
        ["reviewers"] ->
          case req.method {
            Get -> compliance.reviewers(ctx, reviewer)
            Post -> compliance.create_reviewer(ctx, req, reviewer)
            _ -> not_found()
          }
        ["reviewers", rid, "revoke"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            compliance.revoke_reviewer(ctx, req, reviewer, rid)
          })
        ["transactions"] ->
          only(req, Get, fn() {
            transaction_ts_routes.list_all(ctx, req, reviewer)
          })
        ["transactions", "metrics"] ->
          only(req, Get, fn() { transaction_ts_routes.metrics(ctx, reviewer) })
        ["transactions", tid] ->
          only(req, Get, fn() {
            transaction_ts_routes.get_one(ctx, reviewer, tid)
          })
        ["compliance", "audit"] ->
          only(req, Get, fn() { compliance.audit(ctx) })
        ["compliance", "policies"] ->
          case req.method {
            Get -> policy_routes.ts_list(ctx)
            Post -> policy_routes.propose(ctx, req, reviewer)
            _ -> not_found()
          }
        ["compliance", "policies", pid, "approve"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            policy_routes.approve(ctx, req, reviewer, pid)
          })
        ["compliance", "metrics"] ->
          only(req, Get, fn() { compliance.metrics(ctx) })
        ["compliance", "reviews", rid] ->
          only(req, Get, fn() { review_routes.detail(ctx, rid) })
        ["compliance", "reviews", rid, "start"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            review_routes.start(ctx, req, reviewer, rid)
          })
        ["compliance", "reviews", rid, "cancel"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            review_routes.cancel(ctx, req, reviewer, rid)
          })
        ["compliance", "reviews", rid, "supersede"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            review_routes.supersede(ctx, req, reviewer, rid)
          })
        ["compliance", "reviews", rid, "resolve"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            compliance.resolve_review(
              ctx,
              req,
              reviewer,
              rid,
              transaction_routes.binding_decided,
            )
          })
        _ -> not_found()
      }
    }
    ["admin", ..rest] -> {
      use <- access.admin(ctx, req)
      case rest {
        ["players", pid, "level-review"] ->
          only(req, Post, fn() {
            transitions.admin_level_review(ctx, req, id.player(pid))
          })
        ["evidence", "disputes"] ->
          only(req, Get, fn() { passport_routes.admin_disputes(ctx, req) })
        ["box-cam", "disputes"] ->
          only(req, Get, fn() { box_training.dispute_queue(ctx, req) })
        ["box-cam", "disputes", did, "resolve"] ->
          only(req, Post, fn() {
            box_training.resolve_dispute(ctx, req, id.box_dispute(did))
          })
        ["box-cam", "sessions", sid] ->
          only(req, Get, fn() {
            box_session_routes.admin_show(ctx, id.box_session(sid))
          })
        ["combine", "attempts", aid] ->
          only(req, Get, fn() {
            combine_routes.admin_attempt(ctx, id.combine_attempt(aid))
          })
        ["box-cam", "cv", "results", psid] ->
          only(req, Get, fn() { cv_stub.admin_result(ctx, psid) })
        ["box-cam", "sessions", sid, "restore"] ->
          only(req, Post, fn() {
            box_training.restore(ctx, req, id.box_session(sid))
          })
        ["passport", "corrections"] ->
          only(req, Get, fn() { football_passport.admin_corrections(ctx, req) })
        ["passport", "corrections", cid, "resolve"] ->
          only(req, Post, fn() {
            football_passport.admin_resolve(
              ctx,
              req,
              id.passport_correction(cid),
            )
          })
        ["passport", "shares"] ->
          only(req, Get, fn() { sharing.admin_list(ctx, req) })
        ["passport", "shares", sid, "revoke"] ->
          only(req, Post, fn() {
            sharing.admin_revoke(ctx, id.passport_share(sid))
          })
        ["passport", pid, "graph"] ->
          only(req, Get, fn() {
            football_passport.admin_graph(ctx, id.player(pid))
          })
        ["evidence", "disputes", did, "resolve"] ->
          only(req, Post, fn() {
            passport_routes.admin_resolve(ctx, req, id.evidence_dispute(did))
          })
        ["vouches", vid, "withdraw"] ->
          only(req, Post, fn() { vouches.withdraw(ctx, req, id.vouch(vid)) })
        ["drill-guidance"] ->
          only(req, Get, fn() { drill_guidance.admin_list(ctx) })
        ["sweep"] -> only(req, Post, fn() { follow_ups.admin_sweep(ctx, req) })
        ["outcomes"] -> only(req, Get, fn() { follow_ups.admin_outcomes(ctx) })
        ["followups", fid] ->
          only(req, Post, fn() {
            follow_ups.admin_due_at(ctx, req, id.follow_up(fid))
          })
        ["staff-checks"] ->
          only(req, Get, fn() { trial_day.staff_checks(ctx, req) })
        ["staff-checks", tid, sid] ->
          only(req, Post, fn() { trial_day.review_check(ctx, req, tid, sid) })
        ["drill-guidance", did, "review"] ->
          only(req, Post, fn() { drill_guidance.review(ctx, req, did) })
        ["verification", ..path] -> verification_admin(ctx, req, path)
        ["compliance", "reviews"] ->
          only(req, Get, fn() { compliance.admin_review_queue(ctx, req) })
        ["compliance", "policies"] ->
          only(req, Get, fn() { policy_routes.admin_list(ctx) })
        ["agent", "relationships"] ->
          only(req, Get, fn() { agent.admin_relationships(ctx, req) })
        ["agent", "profiles"] ->
          only(req, Get, fn() { agent.admin_profiles(ctx, req) })
        ["outbox"] -> only(req, Get, fn() { admin.outbox(ctx, req) })
        ["backup"] -> only(req, Post, fn() { backups.create(ctx, req) })
        ["backups"] -> only(req, Get, fn() { backups.list(ctx) })
        ["backup", "verify"] ->
          only(req, Post, fn() { backups.verify(ctx, req) })
        ["imports"] -> only(req, Get, fn() { imports.admin_recent(ctx) })
        ["signings", sid, "void"] ->
          only(req, Post, fn() {
            use req <- contract.rerun_on_stale(req)
            signing_routes.admin_void(ctx, req, id.signing_package(sid))
          })
        ["channels"] -> only(req, Get, fn() { threads.admin_list(ctx, req) })
        ["push-log"] -> only(req, Get, fn() { console.push_log(ctx, req) })
        ["groups"] ->
          case req.method {
            Get -> group_routes.admin_page(ctx, req)
            Post -> group_routes.admin_create(ctx, req)
            _ -> not_found()
          }
        ["support"] -> only(req, Get, fn() { support.admin_page(ctx, req) })
        ["support", tid, "reply"] ->
          only(req, Post, fn() { support.reply(ctx, req, id.ticket(tid)) })
        ["support", tid, "request-access"] ->
          only(req, Post, fn() {
            support.request_access(ctx, req, id.ticket(tid))
          })
        ["support", tid, "org-records"] ->
          only(req, Get, fn() { support.org_records(ctx, id.ticket(tid)) })
        ["delivery"] -> only(req, Get, fn() { delivery.admin_view(ctx) })
        ["delivery", "sweep"] ->
          only(req, Post, fn() { delivery.admin_sweep(ctx, req) })
        ["delivery", "inject-failure"] ->
          only(req, Post, fn() { delivery.inject_failure(ctx, req) })
        ["overview"] -> only(req, Get, fn() { console.overview(ctx) })
        ["trust", pid] ->
          only(req, Get, fn() { trust.admin_view(ctx, id.player(pid)) })
        ["trust-policy"] -> only(req, Get, fn() { trust.admin_policy() })
        ["metrics"] -> only(req, Get, fn() { console.metrics(ctx) })
        ["rooms", "overview"] ->
          only(req, Get, fn() { room_routes.admin_overview(ctx) })
        ["reports"] -> only(req, Get, fn() { console.reports(ctx, req) })
        ["reports", report_id, "resolve"] ->
          only(req, Post, fn() {
            console.resolve(ctx, req, id.report(report_id))
          })
        ["blocks"] -> only(req, Get, fn() { console.blocks(ctx, req) })
        ["blocks", block_id, "lift"] ->
          only(req, Post, fn() { console.lift(ctx, req, id.block(block_id)) })
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
    ["evidence", evidence_id] ->
      only(req, Get, fn() {
        review.admin_evidence(ctx, req, id.evidence(evidence_id))
      })
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
    ["root-requests", request_id, "approve"] ->
      only(req, Post, fn() {
        applications.approve(ctx, req, id.root_request(request_id))
      })
    ["root-requests", request_id, "reject"] ->
      only(req, Post, fn() {
        applications.reject(ctx, req, id.root_request(request_id))
      })
    ["domain-requests"] -> only(req, Get, fn() { review.domain_requests(ctx) })
    ["domain-requests", request_id, "decide"] ->
      only(req, Post, fn() {
        review.decide_domain(ctx, req, id.domain_request(request_id))
      })
    ["disputes"] -> only(req, Get, fn() { review.disputes(ctx) })
    ["disputes", dispute_id, "resolve"] ->
      only(req, Post, fn() {
        review.resolve_dispute(ctx, req, id.dispute(dispute_id))
      })
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
    ["references", reference_id, "withdraw"] ->
      only(req, Post, fn() {
        references.withdraw(ctx, req, org, id.reference(reference_id))
      })
    ["references", reference_id, "correct"] ->
      only(req, Post, fn() {
        references.correct(ctx, req, org, id.reference(reference_id))
      })
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
    ["evidence", evidence_id] ->
      only(req, Get, fn() {
        review.org_evidence(ctx, req, org, id.evidence(evidence_id))
      })
    ["domains"] ->
      case req.method {
        Get -> org_admin.domains(ctx, org)
        Post -> org_admin.add_domain(ctx, req, org)
        _ -> not_found()
      }
    ["domains", request_id, "confirm"] ->
      only(req, Post, fn() {
        org_admin.confirm_domain(ctx, req, org, id.domain_request(request_id))
      })
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
    ["conflicts", conflict_id, "withdraw"] ->
      only(req, Post, fn() {
        org_admin.withdraw_conflict(ctx, org, id.conflict(conflict_id))
      })
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
      case req.method {
        Get -> transaction_routes.list_mine(ctx, req, org)
        Post -> transaction_routes.create(ctx, req, org)
        _ -> not_found()
      }
    ["transactions", tid] ->
      only(req, Get, fn() { transaction_routes.get_mine(ctx, org, tid) })
    ["transactions", tid, "timeline"] ->
      only(req, Get, fn() { transaction_routes.timeline_mine(ctx, org, tid) })
    ["transactions", tid, "links"] ->
      only(req, Post, fn() {
        use req <- contract.rerun_on_stale(req)
        transaction_routes.link_opportunity(ctx, req, org, tid)
      })
    ["transactions", tid, "representations"] ->
      only(req, Post, fn() {
        use req <- contract.rerun_on_stale(req)
        transaction_routes.attach_representation(ctx, req, org, tid)
      })
    ["transactions", tid, "representations", rid, "withdraw"] ->
      only(req, Post, fn() {
        use req <- contract.rerun_on_stale(req)
        transaction_routes.withdraw_representation(ctx, req, org, tid, rid)
      })
    ["transactions", tid, "status"] ->
      only(req, Post, fn() {
        use req <- contract.rerun_on_stale(req)
        transaction_routes.move_status(ctx, req, org, tid)
      })
    ["transactions", tid, "terms"] ->
      only(req, Post, fn() {
        use req <- contract.rerun_on_stale(req)
        transaction_routes.record_terms(ctx, req, org, tid)
      })
    ["transactions", tid, "parties"] ->
      only(req, Post, fn() {
        use req <- contract.rerun_on_stale(req)
        transaction_routes.add_party(ctx, req, org, tid)
      })
    ["transactions", tid, "parties", pid, "remove"] ->
      only(req, Post, fn() {
        use req <- contract.rerun_on_stale(req)
        transaction_routes.remove_party(ctx, req, org, tid, pid)
      })
    ["transactions", tid, "documents"] ->
      case req.method {
        Get -> transaction_routes.documents_mine(ctx, org, tid)
        Post -> {
          use req <- contract.rerun_on_stale(req)
          transaction_routes.add_document_mine(ctx, req, org, tid)
        }
        _ -> not_found()
      }
    ["transactions", tid, "documents", did, "reference"] ->
      only(req, Get, fn() {
        transaction_routes.document_reference_mine(ctx, org, tid, did)
      })
    ["transactions", tid, "documents", did, "supersede"] ->
      only(req, Post, fn() {
        use req <- contract.rerun_on_stale(req)
        transaction_routes.supersede_document(ctx, req, org, tid, did)
      })
    ["transactions", tid, "messages"] ->
      only(req, Get, fn() { transaction_routes.messages_mine(ctx, org, tid) })
    ["transactions", tid, "consents", "request"] ->
      only(req, Post, fn() {
        use req <- contract.rerun_on_stale(req)
        transaction_routes.request_consent(ctx, req, org, tid)
      })
    ["transactions", tid, "evaluate"] ->
      only(req, Post, fn() {
        use req <- contract.rerun_on_stale(req)
        transaction_routes.evaluate(ctx, req, org, tid)
      })
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
    ["compliance", "policies"] ->
      only(req, Get, fn() { policy_routes.agent_policies(ctx, org) })
    ["compliance", "overview"] ->
      only(req, Get, fn() { compliance_overview.overview(ctx, org) })
    ["compliance", "contexts"] ->
      case req.method {
        Get -> context_routes.list_contexts(ctx, org)
        Post -> context_routes.create_context(ctx, req, org)
        _ -> not_found()
      }
    ["compliance", "contexts", cid] ->
      only(req, Get, fn() { context_routes.get_context(ctx, org, cid) })
    ["compliance", "contexts", cid, "evaluate"] ->
      only(req, Post, fn() {
        use req <- contract.rerun_on_stale(req)
        context_routes.evaluate(ctx, req, org, cid)
      })
    ["compliance", "contexts", cid, "parties"] ->
      only(req, Post, fn() {
        use req <- contract.rerun_on_stale(req)
        context_routes.add_party(ctx, req, org, cid)
      })
    ["compliance", "contexts", cid, "representations"] ->
      only(req, Post, fn() {
        use req <- contract.rerun_on_stale(req)
        context_routes.declare(ctx, req, org, cid)
      })
    ["compliance", "contexts", cid, "representations", rid, "withdraw"] ->
      only(req, Post, fn() {
        use req <- contract.rerun_on_stale(req)
        context_routes.withdraw(ctx, req, org, cid, rid)
      })
    ["compliance", "contexts", cid, "close"] ->
      only(req, Post, fn() {
        use req <- contract.rerun_on_stale(req)
        context_routes.close(ctx, req, org, cid)
      })
    ["compliance", "contexts", cid, "consents", "request"] ->
      only(req, Post, fn() {
        use req <- contract.rerun_on_stale(req)
        context_routes.request_consent(ctx, req, org, cid)
      })
    ["compliance", "facets", facet, "recheck"] ->
      only(req, Post, fn() { agent.recheck_facet(ctx, req, org, facet) })
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
      only(req, Get, fn() {
        agent.agency_audit(ctx, req, org, [
          transaction_ts_routes.agency_rows(_, org.org.id),
        ])
      })
    ["players"] -> only(req, Get, fn() { agent.players_lookup(ctx, req, org) })
    ["clients"] -> only(req, Get, fn() { agent.clients(ctx, org) })
    ["clients", "request"] ->
      only(req, Post, fn() { agent.request(ctx, req, org) })
    ["clients", rid] ->
      only(req, Get, fn() { agent.client(ctx, org, id.agreement(rid)) })
    ["clients", rid, "terminate"] ->
      only(req, Post, fn() { agent.terminate(ctx, req, org, id.agreement(rid)) })
    ["clients", rid, "offers"] ->
      only(req, Get, fn() {
        offer_routes.agent_offers(ctx, req, org, id.agreement(rid))
      })
    ["clients", rid, "signings"] ->
      only(req, Get, fn() {
        signing_routes.agent_signings(ctx, req, org, id.agreement(rid))
      })
    ["clients", rid, "journey"] ->
      only(req, Get, fn() {
        case_routes.agent_journey(ctx, req, org, id.agreement(rid))
      })
    ["clients", rid, "opportunities"] ->
      only(req, Get, fn() {
        agent.client_opportunities(ctx, org, id.agreement(rid))
      })
    ["clients", rid, "contacts"] ->
      only(req, Get, fn() {
        integration_routes.client_contacts(ctx, org, id.agreement(rid))
      })
    ["clients", rid, "trials"] ->
      only(req, Get, fn() {
        integration_routes.client_trials(ctx, org, id.agreement(rid))
      })
    ["clients", rid, "opportunities", "shares"] ->
      only(req, Get, fn() {
        integration_routes.client_shares(ctx, org, id.agreement(rid))
      })
    ["clients", rid, "opportunities", "shares", sid, "withdraw"] ->
      only(req, Post, fn() {
        use req <- contract.rerun_on_stale(req)
        integration_routes.withdraw_share(
          ctx,
          req,
          org,
          id.agreement(rid),
          id.opportunity_share(sid),
        )
      })
    ["clients", rid, "opportunities", oid, "share"] ->
      only(req, Post, fn() {
        integration_routes.share(ctx, req, org, id.agreement(rid), oid)
      })
    ["handoffs"] -> only(req, Get, fn() { handoffs.agent_list(ctx, org) })
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
/// Every response is counted once it is built, without waiting for the count.
fn counted(ctx: Ctx, req: Request, handler: fn() -> Response) -> Response {
  let started = clock.now_ms()
  let response = handler()
  request_metrics.finished_request(
    ctx.request_metrics,
    path: req.path,
    status: response.status,
    ms: clock.now_ms() - started,
  )
  response
}

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
    [rid, "status"], Post -> {
      use req <- contract.rerun_on_stale(req)
      room_routes.move_status(ctx, req, org, room(rid))
    }
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
    [rid, "signing"], Get -> signing_routes.surface(ctx, req, org, room(rid))
    [rid, "offers"], Post -> {
      use req <- contract.rerun_on_stale(req)
      offer_routes.create(ctx, req, org, room(rid))
    }
    [rid, "transaction-handoff"], Post -> {
      use req <- contract.rerun_on_stale(req)
      handoffs.invite(ctx, req, org, room(rid))
    }
    [rid, "transaction-handoff"], Get -> handoffs.show(ctx, org, room(rid))
    [rid, "transaction-handoff", "withdraw"], Post -> {
      use req <- contract.rerun_on_stale(req)
      handoffs.withdraw(ctx, req, org, room(rid))
    }
    [rid, "journey"], Get -> case_routes.journey(ctx, req, org, room(rid))
    [rid, "lifecycle"], Post -> {
      use req <- contract.rerun_on_stale(req)
      case_routes.lifecycle_act(ctx, req, org, room(rid))
    }
    [rid, "decision"], Get -> case_routes.decision(ctx, org, room(rid))
    [rid, "decision", "draft"], Post ->
      case_routes.start_draft(ctx, req, org, room(rid))
    [rid, "decision", "draft"], Patch ->
      case_routes.edit_draft(ctx, req, org, room(rid))
    [rid, "decision", "draft"], Delete ->
      case_routes.discard_draft(ctx, req, org, room(rid))
    [rid, "decision", "finalize"], Post -> {
      use req <- contract.rerun_on_stale(req)
      case_routes.finalize(ctx, req, org, room(rid), False)
    }
    [rid, "decision", "supersede"], Post -> {
      use req <- contract.rerun_on_stale(req)
      case_routes.finalize(ctx, req, org, room(rid), True)
    }
    _, _ -> not_found()
  }
}

/// `GET /__rate-limits` (development only, on the same guard as `/__faults`): the live buckets, so a battery can
/// see which budget a request drew on without spending it.
fn rate_limits(ctx: Ctx) -> Response {
  contract.json(
    200,
    json.object([
      #(
        "buckets",
        json.array(limits.snapshot(ctx.limits), fn(b) {
          json.object([
            #("action", json.string(b.0)),
            #("key", json.string(b.1)),
            #("spent", json.int(b.2)),
          ])
        }),
      ),
    ]),
  )
}
