//// A guardian's identity check (adapters.mjs `createIdvProvider`). As in the TypeScript server, only the development
//// attestation exists: it approves at once and leaves an audit reference. A real document and liveness provider
//// would answer later and could refuse; that answer would be awaited before the unit, never inside it.

import gleam/string
import scoutbox/platform/secrets

pub const provider = "dev-attestation"

/// A passed check. Only the document reference's last four characters are kept.
pub type Attestation {
  Attestation(reference: String, document_ref_last4: String)
}

pub fn verify(document_ref: String) -> Attestation {
  Attestation(
    reference: "idv_" <> secrets.random_hex(8),
    document_ref_last4: string.drop_start(
      document_ref,
      string.length(document_ref) - 4,
    ),
  )
}
