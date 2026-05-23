import { createElement } from "react";
import { describe, it, expect, vi, afterEach, type Mock } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DocumentReference, DocumentSnapshot } from "firebase/firestore";
import { useFirestoreDocument } from "./use-firestore-document";

afterEach(cleanup);

vi.mock("firebase/firestore", () => ({
  getDoc: vi.fn(),
  onSnapshot: vi.fn(),
}));

const makeRef = () =>
  ({ path: "collection/doc" }) as unknown as DocumentReference;

const makeSnapshot = (data: Record<string, unknown> | undefined) =>
  ({
    exists: () => data !== undefined,
    data: () => data,
  }) as unknown as DocumentSnapshot;

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

describe("useFirestoreDocument", () => {
  it("does not call onSnapshot when ref is undefined", async () => {
    const { onSnapshot } = await import("firebase/firestore");
    const { wrapper } = makeWrapper();

    renderHook(() => useFirestoreDocument(undefined, vi.fn(), ["test"]), {
      wrapper,
    });

    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it("calls onSnapshot with the ref when ref is provided", async () => {
    const { onSnapshot, getDoc } = await import("firebase/firestore");
    (getDoc as Mock).mockResolvedValue(makeSnapshot({ name: "test" }));
    (onSnapshot as Mock).mockImplementation(
      (_ref: unknown, cb: (s: DocumentSnapshot) => void) => {
        cb(makeSnapshot({ name: "test" }));
        return vi.fn();
      },
    );
    const { wrapper } = makeWrapper();
    const ref = makeRef();

    renderHook(
      () =>
        useFirestoreDocument(ref, (s) => s.data() as { name: string }, [
          "test",
        ]),
      { wrapper },
    );

    expect(onSnapshot).toHaveBeenCalledWith(ref, expect.any(Function));
  });

  it("returns deserialized data after getDoc resolves", async () => {
    const { onSnapshot, getDoc } = await import("firebase/firestore");
    const snapshot = makeSnapshot({ name: "Alice" });
    (getDoc as Mock).mockResolvedValue(snapshot);
    (onSnapshot as Mock).mockReturnValue(vi.fn());
    const { wrapper } = makeWrapper();

    const { result } = renderHook(
      () =>
        useFirestoreDocument(
          makeRef(),
          (s) => s.data() as { name: string } | undefined,
          ["test"],
        ),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.data).toEqual({ name: "Alice" });
    });
  });

  it("returns isLoading: false and data: undefined when ref is undefined", () => {
    const { wrapper } = makeWrapper();

    const { result } = renderHook(
      () => useFirestoreDocument(undefined, vi.fn(), ["test"]),
      { wrapper },
    );

    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeUndefined();
  });
});
