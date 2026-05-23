// Node.js runtime is required — firebase-admin does not support the Edge runtime.
export const runtime = "nodejs";

import { type NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";

const AUTH_PAGES = ["/sign-in", "/sign-up", "/forgot-password"];
const SESSION_COOKIE_NAME = "session";

async function getVerifiedUid(
  request: NextRequest,
): Promise<string | undefined> {
  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!sessionCookie) return undefined;
  try {
    const decoded = await getAdminAuth().verifySessionCookie(
      sessionCookie,
      true,
    );
    return decoded.uid;
  } catch {
    return undefined;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isAuthPage = AUTH_PAGES.some((p) => pathname.startsWith(p));

  const uid = await getVerifiedUid(request);

  if (isAuthPage) {
    if (uid) return NextResponse.redirect(new URL("/", request.url));
    return NextResponse.next();
  }

  if (!uid) {
    const signIn = new URL("/sign-in", request.url);
    signIn.searchParams.set("next", pathname);
    return NextResponse.redirect(signIn);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next|favicon.ico|api/auth/session).*)"],
};
