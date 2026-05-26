import { describe, it, expect, vi, afterEach } from "vitest";
import { useContext } from "react";
import { render, screen, cleanup, act } from "@testing-library/react";
import type { User } from "firebase/auth";
import { AuthProvider, AuthContext } from "./AuthProvider";

// `onAuthStateChanged` is invoked inside AuthProvider's useEffect. The mock
// captures the listener so each test can drive auth state transitions.
let capturedListener: ((user: User | null) => void) | undefined;

vi.mock("firebase/auth", () => ({
  onAuthStateChanged: vi.fn((_auth, listener) => {
    capturedListener = listener;
    return () => {
      capturedListener = undefined;
    };
  }),
}));

vi.mock("@/lib/firebase/client", () => ({
  getClientAuth: vi.fn(() => ({})),
}));

afterEach(() => {
  cleanup();
  capturedListener = undefined;
});

function ContextProbe() {
  const value = useContext(AuthContext);
  return (
    <span data-testid="probe">
      {value.loading ? "loading" : value.user ? value.user.email : "signed-out"}
    </span>
  );
}

describe("AuthProvider initial state", () => {
  it("exposes loading=true before onAuthStateChanged fires", () => {
    render(
      <AuthProvider>
        <ContextProbe />
      </AuthProvider>,
    );
    expect(screen.getByTestId("probe").textContent).toBe("loading");
  });
});

describe("AuthProvider on sign-in", () => {
  it("exposes the user once onAuthStateChanged fires with a user", () => {
    render(
      <AuthProvider>
        <ContextProbe />
      </AuthProvider>,
    );
    act(() => {
      capturedListener?.({ email: "alice@example.com" } as User);
    });
    expect(screen.getByTestId("probe").textContent).toBe("alice@example.com");
  });
});

describe("AuthProvider on sign-out", () => {
  it("exposes signed-out state once onAuthStateChanged fires with null", () => {
    render(
      <AuthProvider>
        <ContextProbe />
      </AuthProvider>,
    );
    act(() => {
      capturedListener?.(null);
    });
    expect(screen.getByTestId("probe").textContent).toBe("signed-out");
  });
});
