import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import {
  AuthContext,
  type AuthContextValue,
} from "@/components/auth/AuthProvider";
import { SIGN_IN_COPY } from "./copy";
import SignInPage from "./page";

const mockReplace = vi.fn();
const mockSignInWithPopup = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

vi.mock("firebase/auth", () => {
  class FakeGoogleAuthProvider {
    providerId = "google.com";
  }
  return {
    GoogleAuthProvider: FakeGoogleAuthProvider,
    signInWithPopup: (...args: unknown[]): unknown =>
      mockSignInWithPopup(...args),
  };
});

vi.mock("@/lib/firebase/client", () => ({
  getClientAuth: vi.fn(() => ({})),
}));

afterEach(() => {
  cleanup();
  mockReplace.mockReset();
  mockSignInWithPopup.mockReset();
});

function withAuth(value: Pick<AuthContextValue, "user" | "loading">) {
  // `signOut` is irrelevant to the sign-in page; supply a no-op so each case can
  // specify only the `user`/`loading` axes it exercises.
  const full: AuthContextValue = { ...value, signOut: () => Promise.resolve() };
  return (
    <AuthContext.Provider value={full}>
      <SignInPage />
    </AuthContext.Provider>
  );
}

describe("SignInPage renders the sign-in CTA", () => {
  it("shows the Google sign-in button and project title", () => {
    render(withAuth({ user: undefined, loading: false }));
    expect(
      screen.getByRole("button", { name: SIGN_IN_COPY.buttonGoogle }),
    ).toBeDefined();
    expect(screen.getByText(SIGN_IN_COPY.title)).toBeDefined();
  });
});

describe("SignInPage triggers Firebase popup sign-in when the button is clicked", () => {
  it("calls signInWithPopup with the GoogleAuthProvider", () => {
    mockSignInWithPopup.mockResolvedValue({});
    render(withAuth({ user: undefined, loading: false }));
    fireEvent.click(
      screen.getByRole("button", { name: SIGN_IN_COPY.buttonGoogle }),
    );
    expect(mockSignInWithPopup).toHaveBeenCalledTimes(1);
    const [, provider] = mockSignInWithPopup.mock.calls[0] as [
      unknown,
      { providerId: string },
    ];
    expect(provider.providerId).toBe("google.com");
    // TODO: upgrade to userEvent.click when @testing-library/user-event is available
  });
});

describe("SignInPage redirects when the user is already authenticated", () => {
  it("calls router.replace('/') when an authenticated user lands on /sign-in", () => {
    render(
      withAuth({
        user: { email: "alice@example.com" } as never,
        loading: false,
      }),
    );
    expect(mockReplace).toHaveBeenCalledWith("/");
  });
});

describe("SignInPage shows the popup-closed error when the user dismisses the popup", () => {
  it("renders SIGN_IN_COPY.errorPopupClosed when signInWithPopup rejects with auth/popup-closed-by-user", async () => {
    mockSignInWithPopup.mockRejectedValue({
      code: "auth/popup-closed-by-user",
    });
    render(withAuth({ user: undefined, loading: false }));
    fireEvent.click(
      screen.getByRole("button", { name: SIGN_IN_COPY.buttonGoogle }),
    );
    await waitFor(() => {
      expect(screen.getByText(SIGN_IN_COPY.errorPopupClosed)).toBeDefined();
    });
    // TODO: upgrade to userEvent.click when @testing-library/user-event is available
  });
});

describe("SignInPage shows the generic error for any other auth failure", () => {
  it("renders SIGN_IN_COPY.errorGeneric when signInWithPopup rejects with a different code", async () => {
    mockSignInWithPopup.mockRejectedValue({
      code: "auth/network-request-failed",
    });
    render(withAuth({ user: undefined, loading: false }));
    fireEvent.click(
      screen.getByRole("button", { name: SIGN_IN_COPY.buttonGoogle }),
    );
    await waitFor(() => {
      expect(screen.getByText(SIGN_IN_COPY.errorGeneric)).toBeDefined();
    });
    // TODO: upgrade to userEvent.click when @testing-library/user-event is available
  });
});

describe("SignInPage disables the button and swaps to the signing-in copy while submitting", () => {
  it("renders SIGN_IN_COPY.signingIn on a disabled button after click while the popup is pending", async () => {
    // Pending promise: never resolves within the test, so `submitting` stays true.
    mockSignInWithPopup.mockReturnValue(
      new Promise(() => {
        /* never resolves */
      }),
    );
    render(withAuth({ user: undefined, loading: false }));
    fireEvent.click(
      screen.getByRole("button", { name: SIGN_IN_COPY.buttonGoogle }),
    );
    const submittingButton = await screen.findByRole("button", {
      name: SIGN_IN_COPY.signingIn,
    });
    expect((submittingButton as HTMLButtonElement).disabled).toBe(true);
    // TODO: upgrade to userEvent.click when @testing-library/user-event is available
  });
});
