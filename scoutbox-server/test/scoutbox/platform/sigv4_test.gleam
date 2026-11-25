//// SigV4 presigning. The first case is AWS's own documented example; the others come from a reference signer that
//// reproduces that example and AWS's SDK (`@smithy/signature-v4`), for the shapes `platform/blobs` signs on R2.

import scoutbox/platform/sigv4

const example_key = "AKIAIOSFODNN7EXAMPLE"

const example_secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"

/// 2013-05-24T00:00:00Z.
const example_at = 1_369_353_600_000

const r2_host = "0123456789abcdef.r2.cloudflarestorage.com"

pub fn aws_documented_example_test() {
  let creds = sigv4.Credentials(example_key, example_secret, "us-east-1")
  assert sigv4.presign(
      creds,
      "GET",
      "examplebucket.s3.amazonaws.com",
      "/test.txt",
      [],
      86_400,
      example_at,
    )
    == "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
}

pub fn an_r2_upload_signs_its_length_type_digest_and_no_overwrite_test() {
  let creds = sigv4.Credentials(example_key, example_secret, "auto")
  assert sigv4.presign(
      creds,
      "PUT",
      r2_host,
      "/scoutbox-media/upl-0a1b2c",
      // Out of order and mixed case on purpose: they are signed lower-cased and sorted.
      [
        #(
          "x-amz-checksum-sha256",
          "n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=",
        ),
        #("Content-Type", "video/mp4"),
        #("if-none-match", "*"),
        #("content-length", "1234"),
      ],
      900,
      example_at,
    )
    == "https://0123456789abcdef.r2.cloudflarestorage.com/scoutbox-media/upl-0a1b2c?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=900&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bif-none-match%3Bx-amz-checksum-sha256&X-Amz-Signature=ffbca2683c8013a5adea581d2ff6bd664f53f26675a8f9fe45add4f04f82a043"
}

pub fn an_r2_head_signs_only_the_host_test() {
  let creds = sigv4.Credentials(example_key, example_secret, "auto")
  assert sigv4.presign(
      creds,
      "HEAD",
      r2_host,
      "/scoutbox-media/upl-0a1b2c",
      [],
      60,
      example_at,
    )
    == "https://0123456789abcdef.r2.cloudflarestorage.com/scoutbox-media/upl-0a1b2c?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=60&X-Amz-SignedHeaders=host&X-Amz-Signature=262f41fe654db3c3eae7fbbcf1462008d21716da0454c2b0418a326bad93113d"
}

pub fn encoding_keeps_only_the_unreserved_characters_test() {
  assert sigv4.encode("aZ09-._~") == "aZ09-._~"
  assert sigv4.encode("a/b c+=;*") == "a%2Fb%20c%2B%3D%3B%2A"
  assert sigv4.encode("é") == "%C3%A9"
}
