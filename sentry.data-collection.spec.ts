import { describe, it, expect } from "vitest";
import { sentryDataCollection } from "./sentry.data-collection";

describe("sentryDataCollection", () => {
  it("disables PII collection by default", () => {
    const options = sentryDataCollection(false);
    expect(options).toMatchObject({
      userInfo: false,
      cookies: false,
      httpBodies: [],
      databaseQueryData: false,
      queues: false,
    });
  });

  it("falls back to the SDK defaults when sensitive data is opted in", () => {
    expect(sentryDataCollection(true)).toBeUndefined();
  });
});
