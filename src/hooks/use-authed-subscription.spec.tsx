import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { User } from "firebase/auth";
import { useAuthedSubscription } from "./use-authed-subscription";

// Drive the auth state through a mocked `useAuth`; each render reads the current
// `mockUser`, so a rerender simulates a sign-in/sign-out transition.
let mockUser: Pick<User, "uid"> | undefined;

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: mockUser,
    loading: false,
    signOut: () => Promise.resolve(),
  }),
}));

const unsubscribe = vi.fn();
const subscribe = vi.fn(() => unsubscribe);

afterEach(() => {
  cleanup();
  mockUser = undefined;
  subscribe.mockClear();
  unsubscribe.mockClear();
});

interface ProbeProps {
  subscribe: () => () => void;
}

function Probe({ subscribe }: ProbeProps) {
  useAuthedSubscription(subscribe);
  return null;
}

describe("useAuthedSubscription attaches only when a user is present", () => {
  it("subscribes when a user is signed in", () => {
    mockUser = { uid: "u1" };
    render(<Probe subscribe={subscribe} />);
    expect(subscribe).toHaveBeenCalledOnce();
  });

  it("does not subscribe when signed out", () => {
    mockUser = undefined;
    render(<Probe subscribe={subscribe} />);
    expect(subscribe).not.toHaveBeenCalled();
  });
});

describe("useAuthedSubscription detaches on unmount and sign-out", () => {
  it("unsubscribes when the component unmounts", () => {
    mockUser = { uid: "u1" };
    const { unmount } = render(<Probe subscribe={subscribe} />);
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("unsubscribes when the user signs out", () => {
    mockUser = { uid: "u1" };
    const { rerender } = render(<Probe subscribe={subscribe} />);
    expect(subscribe).toHaveBeenCalledOnce();

    mockUser = undefined;
    rerender(<Probe subscribe={subscribe} />);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
