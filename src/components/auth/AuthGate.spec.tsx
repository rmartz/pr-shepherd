import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { User } from "firebase/auth";
import { AuthGate } from "./AuthGate";
import { AuthContext, type AuthContextValue } from "./AuthProvider";
import { AUTH_GATE_COPY } from "./AuthGate.copy";

const mockReplace = vi.fn();
let currentPathname = "/";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => currentPathname,
}));

afterEach(() => {
  cleanup();
  mockReplace.mockReset();
  currentPathname = "/";
});

function withAuth(children: React.ReactNode, value: AuthContextValue) {
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

describe("AuthGate renders loading state on protected routes while auth resolves", () => {
  it("shows the loading copy when loading=true and pathname is protected", () => {
    currentPathname = "/";
    render(
      withAuth(
        <AuthGate>
          <span data-testid="content">app</span>
        </AuthGate>,
        { user: undefined, loading: true },
      ),
    );
    expect(screen.queryByTestId("content")).toBeNull();
    expect(screen.getByText(AUTH_GATE_COPY.loading)).toBeDefined();
  });
});

describe("AuthGate redirects unauthenticated users away from protected routes", () => {
  it("calls router.replace('/sign-in') when loading is done and user is undefined", () => {
    currentPathname = "/";
    render(
      withAuth(
        <AuthGate>
          <span data-testid="content">app</span>
        </AuthGate>,
        { user: undefined, loading: false },
      ),
    );
    expect(mockReplace).toHaveBeenCalledWith("/sign-in");
    expect(screen.queryByTestId("content")).toBeNull();
  });
});

describe("AuthGate renders children for authenticated users", () => {
  it("renders children when a user is present on a protected route", () => {
    currentPathname = "/";
    render(
      withAuth(
        <AuthGate>
          <span data-testid="content">app</span>
        </AuthGate>,
        { user: { email: "alice@example.com" } as User, loading: false },
      ),
    );
    expect(screen.getByTestId("content").textContent).toBe("app");
    expect(mockReplace).not.toHaveBeenCalled();
  });
});

describe("AuthGate exempts public routes from the redirect", () => {
  it("renders children on /sign-in even when no user is present", () => {
    currentPathname = "/sign-in";
    render(
      withAuth(
        <AuthGate>
          <span data-testid="content">sign-in</span>
        </AuthGate>,
        { user: undefined, loading: false },
      ),
    );
    expect(screen.getByTestId("content").textContent).toBe("sign-in");
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
