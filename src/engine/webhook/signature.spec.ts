import { describe, it, expect } from "vitest";
import { computeSignature, verifySignature } from "./signature";
import { TEST_SECRET } from "./webhook-tests/fixtures";

// ---------------------------------------------------------------------------
// Signature validation (#111 acceptance criterion 1). `computeSignature`
// produces the canonical `sha256=<hex>` GitHub sends; `verifySignature` is
// the accept/reject gate the ingress maps to 202/401.
// ---------------------------------------------------------------------------

const RAW_BODY = JSON.stringify({ action: "opened", number: 7 });

describe("verifySignature accepts a correctly-signed body", () => {
  it("returns true for the signature computed from the same body and secret", () => {
    const header = computeSignature(RAW_BODY, TEST_SECRET);
    expect(verifySignature(RAW_BODY, header, TEST_SECRET)).toBe(true);
  });
});

describe("verifySignature rejects invalid signatures", () => {
  it("returns false when the secret differs", () => {
    const header = computeSignature(RAW_BODY, "wrong-secret");
    expect(verifySignature(RAW_BODY, header, TEST_SECRET)).toBe(false);
  });

  it("returns false when the body was tampered after signing", () => {
    const header = computeSignature(RAW_BODY, TEST_SECRET);
    const tampered = JSON.stringify({ action: "closed", number: 7 });
    expect(verifySignature(tampered, header, TEST_SECRET)).toBe(false);
  });

  it("returns false for a missing signature header", () => {
    expect(verifySignature(RAW_BODY, undefined, TEST_SECRET)).toBe(false);
  });

  it("returns false for a header missing the sha256= prefix", () => {
    const hex = computeSignature(RAW_BODY, TEST_SECRET).slice("sha256=".length);
    expect(verifySignature(RAW_BODY, hex, TEST_SECRET)).toBe(false);
  });
});

describe("computeSignature format", () => {
  it("prefixes the lowercase hex digest with sha256=", () => {
    expect(computeSignature(RAW_BODY, TEST_SECRET)).toMatch(
      /^sha256=[0-9a-f]{64}$/,
    );
  });
});
