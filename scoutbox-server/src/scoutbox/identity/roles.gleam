//// Staff roles: the one definition of the lead tier.
////
//// A role is free text chosen by whoever provisioned the account. The privileged lead tier (approvals, staff
//// management, signings) is derived from that text by one pattern, so no route can grant lead powers the others
//// refuse. The TypeScript server and the web portals share `roles.ts` for this; the two must agree.

import gleam/list
import gleam/string

const lead_words = ["head", "director", "lead", "manager", "owner", "chief"]

/// `/head|director|lead|manager|owner|chief/i`
pub fn is_lead_role(role: String) -> Bool {
  let role = string.lowercase(role)
  list.any(lead_words, string.contains(role, _))
}
