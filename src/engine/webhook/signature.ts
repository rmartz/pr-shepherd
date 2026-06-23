import { createHmac, timingSafeEqual } from "node:crypto";

// GitHub signs every webhook delivery with an HMAC-SHA256 of the raw
// request body, keyed by the repository/app webhook secret, and sends it
// in the `X-Hub-Signature-256` header as `sha256=<hex>` (see GitHub's
// "Validating webhook deliveries" docs). The receiver must recompute the
// HMAC over the *exact* raw body bytes and compare in constant time — a
// non-constant comparison leaks signature bytes through timing.
//
// This module is the pure verification primitive: it takes the raw body,
// the header value, and the secret, and returns a boolean. The ingress
// (`src/app/api/webhook/github`) supplies the secret from the environment
// and the raw body from the request — keeping this function free of any
// framework or I/O so it is exhaustively unit-testable (#111 criterion 1).

const SIGNATURE_PREFIX = "sha256=";

// Compute the canonical `sha256=<hex>` signature for a raw body + secret.
// Exported so callers (and tests) can produce the value GitHub would send.
export function computeSignature(rawBody: string, secret: string): string {
  return (
    SIGNATURE_PREFIX +
    createHmac("sha256", secret).update(rawBody).digest("hex")
  );
}

// Returns true iff `signatureHeader` is the valid `X-Hub-Signature-256`
// for `rawBody` under `secret`. A missing/empty header, a header without
// the `sha256=` prefix, or a length mismatch all return false rather than
// throwing — the ingress maps a false result to a 401, never a 500.
export function verifySignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (signatureHeader === undefined || signatureHeader.length === 0) {
    return false;
  }
  const expected = computeSignature(rawBody, secret);
  // `timingSafeEqual` throws on differing buffer lengths, which would
  // itself leak length information and crash the handler — guard the
  // length first, then compare the equal-length buffers in constant time.
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(signatureHeader);
  if (expectedBytes.length !== actualBytes.length) {
    return false;
  }
  return timingSafeEqual(expectedBytes, actualBytes);
}
