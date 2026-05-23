"use client";

import { useEffect, useRef } from "react";
import {
  get,
  onValue,
  type DatabaseReference,
  type DataSnapshot,
} from "firebase/database";
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";

/**
 * Subscribes to a Realtime Database path and keeps TanStack Query's cache in
 * sync. The queryFn performs a one-shot read for the initial load; the useEffect
 * subscription keeps the cache updated on every subsequent push.
 *
 * Pass a stable queryKey (constant or memoised) to avoid redundant re-subscriptions.
 * Mutations that write to the same path will trigger the Firebase push automatically;
 * call queryClient.invalidateQueries({ queryKey }) if you need to force a refetch.
 */
export function useRealtimeValue<T>(
  ref: DatabaseReference | undefined,
  deserialize: (snapshot: DataSnapshot) => T,
  queryKey: QueryKey,
) {
  const queryClient = useQueryClient();
  const queryKeyRef = useRef(queryKey);
  queryKeyRef.current = queryKey;
  const deserializeRef = useRef(deserialize);
  deserializeRef.current = deserialize;

  useEffect(() => {
    if (!ref) return;
    return onValue(ref, (snapshot) => {
      queryClient.setQueryData(
        queryKeyRef.current,
        deserializeRef.current(snapshot),
      );
    });
  }, [ref, queryClient]);

  return useQuery<T>({
    queryKey,
    queryFn: async () => {
      if (!ref) throw new Error("ref is required");
      return deserializeRef.current(await get(ref));
    },
    enabled: ref !== undefined,
  });
}
