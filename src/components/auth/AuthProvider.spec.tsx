import { describe, it, expect, vi, afterEach } from "vitest";
import { useContext } from "react";
import {
  render,
  screen,
  cleanup,
  act,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import type { User } from "firebase/auth";
import { AuthProvider, AuthContext } from "./AuthProvider";

// `onAuthStateChanged` is invoked inside AuthProvider's useEffect. The mock
// captures the listener so each test can drive auth state transitions.
// `signOut` is a spy so the sign-out test can assert the provider delegates to
// Firebase.
let capturedListener: ((user: User | null) => void) | undefined;
const firebaseSignOut = vi.fn(() => Promise.resolve());

vi.mock("firebase/auth", () => ({
  onAuthStateChanged: vi.fn((_auth, listener) => {
    capturedListener = listener;
    return () => {
      capturedListener = undefined;
    };
  }),
  signOut: () => firebaseSignOut(),
}));

vi.mock("@/lib/firebase/client", () => ({
  getClientAuth: vi.fn(() => ({})),
}));

afterEach(() => {
  cleanup();
  capturedListener = undefined;
  firebaseSignOut.mockClear();
});

function ContextProbe() {
  const value = useContext(AuthContext);
  return (
    <span data-testid="probe">
      {value.loading ? "loading" : value.user ? value.user.email : "signed-out"}
    </span>
  );
}

function SignOutProbe() {
  const { signOut } = useContext(AuthContext);
  return (
    <button
      type="button"
      onClick={() => {
        void signOut();
      }}
    >
      sign out
    </button>
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

describe("AuthProvider signOut", () => {
  it("delegates to Firebase signOut", async () => {
    render(
      <AuthProvider>
        <SignOutProbe />
      </AuthProvider>,
    );
    // TODO: upgrade to userEvent.click when @testing-library/user-event is available
    fireEvent.click(screen.getByRole("button", { name: "sign out" }));
    await waitFor(() => {
      expect(firebaseSignOut).toHaveBeenCalledOnce();
    });
  });
});
