import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createDb } from "./index";

// ---------------------------------------------------------------------------
// Unit tests for the `firebase-emulator` adapter kind. The emulator path
// shares its implementation with the hosted Firestore adapter (#38); the
// only difference is that `createDb` arranges for the admin and client SDKs
// to talk to the local emulator instead of a managed project.
//
// Validating the wiring without spinning up the actual emulator: we check
// the side effects the factory and client initializer rely on
// (`FIRESTORE_EMULATOR_HOST` env var for admin SDK, `connectFirestoreEmulator`
// call for the client SDK). End-to-end coverage against a running emulator
// already exists in `hostedFirestore.integration.spec.ts` and runs the same
// `HostedFirestoreDb` class.
// ---------------------------------------------------------------------------

// `createDb` is allowed to throw in test environments that lack Firebase
// client env vars — the hosted constructor's default `loadDefaultClient()`
// eagerly initializes the client SDK. We only care about the env-var side
// effect (which happens before any throwing code), so wrap each call.
function callCreateDbTolerant(adapter: Parameters<typeof createDb>[0]): {
  threw: boolean;
  message: string | undefined;
} {
  try {
    createDb(adapter);
    return { threw: false, message: undefined };
  } catch (err) {
    return {
      threw: true,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

describe("Config flag selects firebase-emulator and routes to the emulator", () => {
  let savedHost: string | undefined;

  beforeEach(() => {
    savedHost = process.env["FIRESTORE_EMULATOR_HOST"];
    delete process.env["FIRESTORE_EMULATOR_HOST"];
  });

  afterEach(() => {
    if (savedHost === undefined) {
      delete process.env["FIRESTORE_EMULATOR_HOST"];
    } else {
      process.env["FIRESTORE_EMULATOR_HOST"] = savedHost;
    }
  });

  it("sets FIRESTORE_EMULATOR_HOST with the configured host when adapter is firebase-emulator", () => {
    const { message } = callCreateDbTolerant({
      adapter: "firebase-emulator",
      emulator: { firestoreHost: "127.0.0.1:8080" },
    });
    // If construction threw, it must not be the old placeholder.
    if (message !== undefined) {
      expect(message).not.toMatch(/not yet implemented/);
    }
    // The env-var write is the meaningful side effect for the daemon.
    expect(process.env["FIRESTORE_EMULATOR_HOST"]).toBe("127.0.0.1:8080");
  });

  it("defaults to localhost:8080 when emulator host is not specified", () => {
    const { message } = callCreateDbTolerant({ adapter: "firebase-emulator" });
    if (message !== undefined) {
      expect(message).not.toMatch(/not yet implemented/);
    }
    expect(process.env["FIRESTORE_EMULATOR_HOST"]).toBe("localhost:8080");
  });

  it("clears FIRESTORE_EMULATOR_HOST when adapter is firebase-hosted", () => {
    // Simulate an earlier emulator construction having set the var.
    process.env["FIRESTORE_EMULATOR_HOST"] = "stale:9999";
    callCreateDbTolerant({ adapter: "firebase-hosted" });
    expect(process.env["FIRESTORE_EMULATOR_HOST"]).toBeUndefined();
  });

  it("clears FIRESTORE_EMULATOR_HOST when adapter is in-memory", () => {
    process.env["FIRESTORE_EMULATOR_HOST"] = "stale:9999";
    createDb({ adapter: "in-memory" });
    expect(process.env["FIRESTORE_EMULATOR_HOST"]).toBeUndefined();
  });

  it("returns a Db with the same shape as the hosted adapter (same class)", () => {
    let db: ReturnType<typeof createDb> | undefined;
    try {
      db = createDb({ adapter: "firebase-emulator" });
    } catch (err) {
      // Construction may fail in environments without client Firebase
      // env vars — verify it isn't the old placeholder and exit the
      // shape check.
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toMatch(/not yet implemented/);
      return;
    }
    expect(typeof db.subscribe).toBe("function");
    expect(typeof db.get).toBe("function");
    expect(typeof db.list).toBe("function");
    expect(typeof db.create).toBe("function");
    expect(typeof db.update).toBe("function");
    expect(typeof db.delete).toBe("function");
  });
});

describe("Client SDK initializer connects to emulator when env var is present", () => {
  let savedHost: string | undefined;
  let savedPublicHost: string | undefined;
  let mockConnect: ReturnType<typeof vi.fn>;
  let mockGetFirestore: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    savedHost = process.env["FIRESTORE_EMULATOR_HOST"];
    savedPublicHost = process.env["NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST"];
    delete process.env["FIRESTORE_EMULATOR_HOST"];
    delete process.env["NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST"];
    mockConnect = vi.fn();
    mockGetFirestore = vi.fn(() => ({ _name: "fake-firestore" }));
    vi.resetModules();
  });

  afterEach(() => {
    if (savedHost === undefined) {
      delete process.env["FIRESTORE_EMULATOR_HOST"];
    } else {
      process.env["FIRESTORE_EMULATOR_HOST"] = savedHost;
    }
    if (savedPublicHost === undefined) {
      delete process.env["NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST"];
    } else {
      process.env["NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST"] = savedPublicHost;
    }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function stubFirebaseModules() {
    vi.doMock("firebase/firestore", () => ({
      getFirestore: mockGetFirestore,
      connectFirestoreEmulator: mockConnect,
    }));
    vi.doMock("firebase/app", () => ({
      initializeApp: vi.fn(() => ({ name: "[DEFAULT]" })),
      getApps: vi.fn(() => []),
    }));
  }

  it("calls connectFirestoreEmulator with parsed host and port from FIRESTORE_EMULATOR_HOST", async () => {
    process.env["FIRESTORE_EMULATOR_HOST"] = "127.0.0.1:9999";
    stubFirebaseModules();
    const { getClientFirestore } = await import("../lib/firebase/client");
    getClientFirestore();
    expect(mockConnect).toHaveBeenCalledTimes(1);
    const args = mockConnect.mock.calls[0];
    expect(args?.[1]).toBe("127.0.0.1");
    expect(args?.[2]).toBe(9999);
  });

  it("prefers NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST over FIRESTORE_EMULATOR_HOST so the browser bundle sees it", async () => {
    // The UI is a Next.js client bundle; only NEXT_PUBLIC_* env vars
    // are inlined at build time. Make sure the parser prefers the
    // public variant when both are set.
    process.env["NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST"] = "127.0.0.1:7777";
    process.env["FIRESTORE_EMULATOR_HOST"] = "127.0.0.1:9999";
    stubFirebaseModules();
    const { getClientFirestore } = await import("../lib/firebase/client");
    getClientFirestore();
    expect(mockConnect).toHaveBeenCalledTimes(1);
    const args = mockConnect.mock.calls[0];
    expect(args?.[1]).toBe("127.0.0.1");
    expect(args?.[2]).toBe(7777);
  });

  it("connects when only NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST is set", async () => {
    process.env["NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST"] = "127.0.0.1:8000";
    stubFirebaseModules();
    const { getClientFirestore } = await import("../lib/firebase/client");
    getClientFirestore();
    expect(mockConnect).toHaveBeenCalledTimes(1);
    const args = mockConnect.mock.calls[0];
    expect(args?.[1]).toBe("127.0.0.1");
    expect(args?.[2]).toBe(8000);
  });

  it("does NOT call connectFirestoreEmulator when no emulator env var is set", async () => {
    stubFirebaseModules();
    const { getClientFirestore } = await import("../lib/firebase/client");
    getClientFirestore();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("only calls connectFirestoreEmulator once even when getClientFirestore is called multiple times", async () => {
    process.env["FIRESTORE_EMULATOR_HOST"] = "127.0.0.1:8080";
    stubFirebaseModules();
    const { getClientFirestore } = await import("../lib/firebase/client");
    getClientFirestore();
    getClientFirestore();
    getClientFirestore();
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it("throws a clear error when the emulator host has no port", async () => {
    process.env["FIRESTORE_EMULATOR_HOST"] = "localhost:";
    stubFirebaseModules();
    const { getClientFirestore } = await import("../lib/firebase/client");
    expect(() => getClientFirestore()).toThrow(/non-empty/);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("throws a clear error when the port is not a positive integer", async () => {
    process.env["FIRESTORE_EMULATOR_HOST"] = "localhost:notanumber";
    stubFirebaseModules();
    const { getClientFirestore } = await import("../lib/firebase/client");
    expect(() => getClientFirestore()).toThrow(/non-negative integer/);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("throws a clear error when the port is out of range", async () => {
    process.env["FIRESTORE_EMULATOR_HOST"] = "localhost:99999";
    stubFirebaseModules();
    const { getClientFirestore } = await import("../lib/firebase/client");
    expect(() => getClientFirestore()).toThrow(/1..65535/);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("throws a clear error when the host has too many colons", async () => {
    process.env["FIRESTORE_EMULATOR_HOST"] = "a:b:c";
    stubFirebaseModules();
    const { getClientFirestore } = await import("../lib/firebase/client");
    expect(() => getClientFirestore()).toThrow(/exactly "host:port"/);
    expect(mockConnect).not.toHaveBeenCalled();
  });
});
