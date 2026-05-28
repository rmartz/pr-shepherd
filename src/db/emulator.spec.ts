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
    createDb({
      adapter: "firebase-emulator",
      emulator: { firestoreHost: "127.0.0.1:8080" },
    });
    expect(process.env["FIRESTORE_EMULATOR_HOST"]).toBe("127.0.0.1:8080");
  });

  it("defaults to localhost:8080 when emulator host is not specified", () => {
    createDb({ adapter: "firebase-emulator" });
    expect(process.env["FIRESTORE_EMULATOR_HOST"]).toBe("localhost:8080");
  });

  it("does NOT set FIRESTORE_EMULATOR_HOST when adapter is firebase-hosted", () => {
    expect(process.env["FIRESTORE_EMULATOR_HOST"]).toBeUndefined();
    createDb({ adapter: "firebase-hosted" });
    expect(process.env["FIRESTORE_EMULATOR_HOST"]).toBeUndefined();
  });

  it("returns a Db with the same shape as the hosted adapter (same class)", () => {
    const db = createDb({ adapter: "firebase-emulator" });
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
  let mockConnect: ReturnType<typeof vi.fn>;
  let mockGetFirestore: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    savedHost = process.env["FIRESTORE_EMULATOR_HOST"];
    delete process.env["FIRESTORE_EMULATOR_HOST"];
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
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("calls connectFirestoreEmulator with the parsed host and port when FIRESTORE_EMULATOR_HOST is set", async () => {
    process.env["FIRESTORE_EMULATOR_HOST"] = "127.0.0.1:9999";
    vi.doMock("firebase/firestore", () => ({
      getFirestore: mockGetFirestore,
      connectFirestoreEmulator: mockConnect,
    }));
    vi.doMock("firebase/app", () => ({
      initializeApp: vi.fn(() => ({ name: "[DEFAULT]" })),
      getApps: vi.fn(() => []),
    }));
    const { getClientFirestore } = await import("../lib/firebase/client");
    getClientFirestore();
    expect(mockConnect).toHaveBeenCalledTimes(1);
    const args = mockConnect.mock.calls[0];
    expect(args?.[1]).toBe("127.0.0.1");
    expect(args?.[2]).toBe(9999);
  });

  it("does NOT call connectFirestoreEmulator when FIRESTORE_EMULATOR_HOST is not set", async () => {
    vi.doMock("firebase/firestore", () => ({
      getFirestore: mockGetFirestore,
      connectFirestoreEmulator: mockConnect,
    }));
    vi.doMock("firebase/app", () => ({
      initializeApp: vi.fn(() => ({ name: "[DEFAULT]" })),
      getApps: vi.fn(() => []),
    }));
    const { getClientFirestore } = await import("../lib/firebase/client");
    getClientFirestore();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("only calls connectFirestoreEmulator once even when getClientFirestore is called multiple times", async () => {
    process.env["FIRESTORE_EMULATOR_HOST"] = "127.0.0.1:8080";
    vi.doMock("firebase/firestore", () => ({
      getFirestore: mockGetFirestore,
      connectFirestoreEmulator: mockConnect,
    }));
    vi.doMock("firebase/app", () => ({
      initializeApp: vi.fn(() => ({ name: "[DEFAULT]" })),
      getApps: vi.fn(() => []),
    }));
    const { getClientFirestore } = await import("../lib/firebase/client");
    getClientFirestore();
    getClientFirestore();
    getClientFirestore();
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });
});
