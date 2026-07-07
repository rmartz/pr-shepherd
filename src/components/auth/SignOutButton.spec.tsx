import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { SignOutButton } from "./SignOutButton";
import { SIGN_OUT_BUTTON_COPY } from "./SignOutButton.copy";

// The button consumes the auth context's `signOut`; mock the hook so the test
// verifies the wiring without a real Firebase auth instance.
const signOut = vi.fn(() => Promise.resolve());

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { email: "op@example.com" },
    loading: false,
    signOut,
  }),
}));

afterEach(() => {
  cleanup();
  signOut.mockClear();
});

describe("SignOutButton triggers the auth context sign-out", () => {
  it("calls signOut when clicked", async () => {
    render(<SignOutButton />);

    // TODO: upgrade to userEvent.click when @testing-library/user-event is available
    fireEvent.click(
      screen.getByRole("button", { name: SIGN_OUT_BUTTON_COPY.button }),
    );

    await waitFor(() => {
      expect(signOut).toHaveBeenCalledOnce();
    });
  });
});
