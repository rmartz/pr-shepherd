import { createElement } from "react";
import { describe, it, expect, vi, afterEach, type Mock } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DatabaseReference, DataSnapshot } from "firebase/database";
import { useRealtimeValue } from "./use-realtime-value";

afterEach(cleanup);

vi.mock("firebase/database", () => ({ get: vi.fn(), onValue: vi.fn() }));

const makeRef = () =>
  ({ toString: () => "https://test.firebaseio.com/path" }) as DatabaseReference;

const makeSnapshot = (value: unknown) => ({ val: () => value }) as DataSnapshot;

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    queryClient,
    wrapper: ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children),
  };
}

describe("useRealtimeValue", () => {
  it("does not call onValue when ref is undefined", async () => {
    const { onValue } = await import("firebase/database");
    const { wrapper } = makeWrapper();

    renderHook(() => useRealtimeValue(undefined, vi.fn(), ["test"]), {
      wrapper,
    });

    expect(onValue).not.toHaveBeenCalled();
  });

  it("calls onValue with the ref when ref is provided", async () => {
    const { get, onValue } = await import("firebase/database");
    (get as Mock).mockResolvedValue(makeSnapshot("value"));
    (onValue as Mock).mockImplementation(
      (_ref: unknown, cb: (s: DataSnapshot) => void) => {
        cb(makeSnapshot("value"));
        return vi.fn();
      },
    );
    const { wrapper } = makeWrapper();
    const ref = makeRef();

    renderHook(
      () => useRealtimeValue(ref, (s) => s.val() as string, ["test"]),
      { wrapper },
    );

    expect(onValue).toHaveBeenCalledWith(ref, expect.any(Function));
  });

  it("returns deserialized data from the initial get()", async () => {
    const { get, onValue } = await import("firebase/database");
    (get as Mock).mockResolvedValue(makeSnapshot("hello"));
    (onValue as Mock).mockReturnValue(vi.fn());
    const { wrapper } = makeWrapper();

    const { result } = renderHook(
      () =>
        useRealtimeValue(makeRef(), (s) => (s.val() as string).toUpperCase(), [
          "test",
        ]),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.data).toBe("HELLO");
    });
  });

  it("returns isLoading: false and data: undefined when ref is undefined", () => {
    const { wrapper } = makeWrapper();

    const { result } = renderHook(
      () => useRealtimeValue(undefined, vi.fn(), ["test"]),
      { wrapper },
    );

    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeUndefined();
  });
});
