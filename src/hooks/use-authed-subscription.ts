"use client";

import { useEffect } from "react";
import type { Unsubscribe } from "firebase/firestore";
import { useAuth } from "@/hooks/use-auth";

// ---------------------------------------------------------------------------
// Bind a Firestore subscription to the authenticated session (#304). The
// client subscriptions in `lib/firebase/subscriptions` run as the signed-in
// user, so they must attach only once a user is present and detach the instant
// the user signs out — otherwise a signed-out client keeps an open listener
// that Firestore rules will reject.
//
// `subscribe` opens the subscription and returns its `Unsubscribe`. The hook
// (re)invokes it whenever the signed-in identity or the factory changes, and
// tears the subscription down on sign-out and on unmount. Callers memoize
// `subscribe` (e.g. `useCallback` keyed on a `runId`) so a re-render does not
// churn the listener; a changed factory is treated as an intentional
// re-subscribe.
// ---------------------------------------------------------------------------

export function useAuthedSubscription(subscribe: () => Unsubscribe): void {
  const { user } = useAuth();
  const uid = user?.uid;

  useEffect(() => {
    // No user → nothing to subscribe. On sign-out this branch runs after the
    // previous effect's cleanup has already detached the listener.
    if (uid === undefined) {
      return;
    }
    const unsubscribe = subscribe();
    return unsubscribe;
  }, [uid, subscribe]);
}
