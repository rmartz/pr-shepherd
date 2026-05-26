import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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

function withAuth(value: AuthContextValue) {
  return (
    <AuthContext.Provider value={value}>
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
