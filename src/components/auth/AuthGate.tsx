"use client";

import { useRouter, usePathname } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { AUTH_GATE_COPY } from "./AuthGate.copy";

interface AuthGateProps {
  children: React.ReactNode;
}

const PUBLIC_PATHS = ["/sign-in"];

function isPublicPath(pathname: string | null): boolean {
  return pathname !== null && PUBLIC_PATHS.includes(pathname);
}

export function AuthGate({ children }: AuthGateProps) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const publicPath = isPublicPath(pathname);

  useEffect(() => {
    if (loading) return;
    if (!user && !publicPath) {
      router.replace("/sign-in");
    }
  }, [user, loading, publicPath, router]);

  // While the auth state is unresolved, show a neutral loading state on
  // protected routes; public routes (sign-in) render their children immediately.
  return (
    <>
      {loading && !publicPath ? (
        <div className="flex flex-1 items-center justify-center text-zinc-600">
          {AUTH_GATE_COPY.loading}
        </div>
      ) : !user && !publicPath ? (
        <div className="flex flex-1 items-center justify-center text-zinc-600">
          {AUTH_GATE_COPY.redirecting}
        </div>
      ) : (
        children
      )}
    </>
  );
}
