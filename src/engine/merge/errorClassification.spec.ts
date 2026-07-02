import { describe, it, expect } from "vitest";
import { classifyMergeError, mergeErrorMessage } from "./errorClassification";

// The classifier decides whether a merge failure can ever succeed on a retry.
// Operator-actionable causes (scope/permission/creds/SSO) escalate immediately;
// everything else is transient and retried against the durable budget.

describe("classifyMergeError flags operator-actionable failures", () => {
  it("classifies a missing `workflow` scope as operator-actionable", () => {
    expect(
      classifyMergeError(
        "refusing to allow an OAuth App to create or update workflow",
      ),
    ).toBe("operator_actionable");
  });

  it("classifies bad credentials as operator-actionable", () => {
    expect(classifyMergeError("Bad credentials")).toBe("operator_actionable");
  });

  it("classifies a missing-permission 403 as operator-actionable", () => {
    expect(
      classifyMergeError("Resource not accessible by integration (HTTP 403)"),
    ).toBe("operator_actionable");
  });

  it("classifies an SSO authorization requirement as operator-actionable", () => {
    expect(
      classifyMergeError("You must grant your token SSO access to this org"),
    ).toBe("operator_actionable");
  });
});

describe("classifyMergeError treats retryable failures as transient", () => {
  it("classifies a mergeability race as transient", () => {
    expect(
      classifyMergeError("Base branch was modified. Review and try again."),
    ).toBe("transient");
  });

  it("classifies persistent branch protection as transient (may clear on its own)", () => {
    expect(
      classifyMergeError(
        "At least 1 approving review is required by reviewers",
      ),
    ).toBe("transient");
  });
});

describe("mergeErrorMessage extracts a classifiable string", () => {
  it("reads the message off an Error instance", () => {
    expect(mergeErrorMessage(new Error("Bad credentials"))).toBe(
      "Bad credentials",
    );
  });

  it("stringifies a non-Error thrown value", () => {
    expect(mergeErrorMessage("plain string failure")).toBe(
      "plain string failure",
    );
  });
});
