"use client";

import { useEffect, useRef } from "react";
import {
  getDoc,
  onSnapshot,
  type DocumentReference,
  type DocumentSnapshot,
} from "firebase/firestore";
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";

/**
 * Subscribes to a Firestore document and keeps TanStack Query's cache in sync.
 * The queryFn performs a one-shot getDoc for the initial load; the useEffect
 * subscription keeps the cache updated on every subsequent write.
 *
 * Pass a stable queryKey (constant or memoised) to avoid redundant re-subscriptions.
 * Mutations that write to the same document will trigger the Firestore push
 * automatically; call queryClient.invalidateQueries({ queryKey }) if you need to
 * force a refetch.
 */
export function useFirestoreDocument<T>(
  ref: DocumentReference | undefined,
  deserialize: (snapshot: DocumentSnapshot) => T | undefined,
  queryKey: QueryKey,
) {
  const queryClient = useQueryClient();
  const queryKeyRef = useRef(queryKey);
  queryKeyRef.current = queryKey;
  const deserializeRef = useRef(deserialize);
  deserializeRef.current = deserialize;

  useEffect(() => {
    if (!ref) return;
    return onSnapshot(ref, (snapshot) => {
      queryClient.setQueryData(
        queryKeyRef.current,
        deserializeRef.current(snapshot),
      );
    });
  }, [ref, queryClient]);

  return useQuery<T | undefined>({
    queryKey,
    queryFn: async () => {
      if (!ref) throw new Error("ref is required");
      return deserializeRef.current(await getDoc(ref));
    },
    enabled: ref !== undefined,
  });
}
