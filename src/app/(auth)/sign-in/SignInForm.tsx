"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { FirebaseError } from "firebase/app";
import { createSession, signIn } from "@/services/auth";
import { SIGN_IN_COPY } from "./copy";

export default function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.SyntheticEvent) {
    e.preventDefault();
    setError(undefined);
    setLoading(true);
    try {
      const credential = await signIn(email, password);
      await createSession(await credential.user.getIdToken());
      const next = searchParams.get("next");
      const redirectTo =
        next?.startsWith("/") && !next.startsWith("//") ? next : "/";
      router.push(redirectTo);
    } catch (err) {
      const code = (err as FirebaseError).code;
      const messages = SIGN_IN_COPY.errors;
      setError((messages as Record<string, string>)[code] ?? messages.default);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-sm space-y-6">
      <h1 className="text-2xl font-semibold">{SIGN_IN_COPY.title}</h1>
      <form
        onSubmit={(e) => {
          void handleSubmit(e);
        }}
        className="space-y-4"
      >
        <div className="space-y-1">
          <label htmlFor="email" className="text-sm font-medium">
            {SIGN_IN_COPY.emailLabel}
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
            placeholder={SIGN_IN_COPY.emailPlaceholder}
            className="w-full rounded border px-3 py-2 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="password" className="text-sm font-medium">
            {SIGN_IN_COPY.passwordLabel}
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            className="w-full rounded border px-3 py-2 text-sm"
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {SIGN_IN_COPY.submitButton}
        </button>
      </form>
      <div className="flex items-center justify-between text-sm">
        <Link href="/forgot-password" className="underline">
          {SIGN_IN_COPY.forgotPasswordLink}
        </Link>
        <span>
          {SIGN_IN_COPY.signUpPrompt}{" "}
          <Link href="/sign-up" className="underline">
            {SIGN_IN_COPY.signUpLink}
          </Link>
        </span>
      </div>
    </div>
  );
}
