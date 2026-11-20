//// The `briefIsLiveOn` call the battery recorder can't keep: a missing brief is not live (contracts §9). No brief
//// reaches `briefs.is_live_on` here unless it was found: an unknown brief, or another organisation's, is no brief,
//// and its route answers 404 before liveness is read.

import gleam/option.{None}
import scoutbox/discovery/briefs
import scoutbox/platform/store
import scoutbox/rows/id
import scoutbox/support

pub fn a_missing_brief_is_no_brief_test() {
  let s = support.fresh_store(fn(_) { Nil })
  let assert Ok(None) =
    store.read(s, briefs.for_org_by_id(
      _,
      id.brief("brf-nobody-made"),
      id.org("org-eastport"),
    ))
}
