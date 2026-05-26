"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  GoogleAuthProvider,
  signInWithPopup,
  type AuthError,
} from "firebase/auth";
import { getClientAuth } from "@/lib/firebase/client";
import { useAuth } from "@/hooks/use-auth";
import { SIGN_IN_COPY } from "./copy";

export default function SignInPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!loading && user) {
      router.replace("/");
    }
  }, [user, loading, router]);

  const handleSignIn = async () => {
    setSubmitting(true);
    setError(undefined);
    try {
      await signInWithPopup(getClientAuth(), new GoogleAuthProvider());
      // The useEffect above will redirect once `user` updates.
    } catch (caught) {
      const authError = caught as AuthError;
      const message =
        authError.code === "auth/popup-closed-by-user"
          ? SIGN_IN_COPY.errorPopupClosed
          : SIGN_IN_COPY.errorGeneric;
      setError(message);
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center">
      <main className="flex flex-col items-center gap-6 text-center">
        <h1 className="text-4xl font-semibold tracking-tight">
          {SIGN_IN_COPY.title}
        </h1>
        <p className="max-w-md text-lg text-zinc-600 dark:text-zinc-400">
          {SIGN_IN_COPY.subtitle}
        </p>
        <button
          type="button"
          onClick={() => {
            void handleSignIn();
          }}
          disabled={submitting}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-50 hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {submitting ? SIGN_IN_COPY.signingIn : SIGN_IN_COPY.buttonGoogle}
        </button>
        {error !== undefined && (
          <p className="max-w-md text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </main>
    </div>
  );
}
