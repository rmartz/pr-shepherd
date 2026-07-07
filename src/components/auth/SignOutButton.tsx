"use client";

import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { SIGN_OUT_BUTTON_COPY } from "./SignOutButton.copy";

// The operator's sign-out control. On success `AuthProvider`'s
// `onAuthStateChanged` clears the user and `AuthGate` redirects to `/sign-in`,
// so this component simply unmounts — no explicit navigation needed. Until the
// app shell lands (#306) it lives on the placeholder home page; the shell will
// relocate it into the persistent chrome.
export function SignOutButton() {
  const { signOut } = useAuth();
  const [submitting, setSubmitting] = useState(false);

  const handleSignOut = async () => {
    setSubmitting(true);
    try {
      await signOut();
      // AuthGate redirects once the user clears; leave `submitting` set so the
      // button stays disabled through the unmount.
    } catch {
      setSubmitting(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => {
        void handleSignOut();
      }}
      disabled={submitting}
      className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
    >
      {submitting
        ? SIGN_OUT_BUTTON_COPY.signingOut
        : SIGN_OUT_BUTTON_COPY.button}
    </button>
  );
}
