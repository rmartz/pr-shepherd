import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";

const SESSION_COOKIE_NAME = "session";
const SESSION_DURATION_MS = 60 * 60 * 24 * 5 * 1000; // 5 days

export async function POST(request: Request) {
  const body = (await request.json()) as { idToken: unknown };
  if (typeof body.idToken !== "string" || !body.idToken) {
    return NextResponse.json({ error: "idToken is required" }, { status: 400 });
  }
  const sessionCookie = await getAdminAuth().createSessionCookie(body.idToken, {
    expiresIn: SESSION_DURATION_MS,
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, sessionCookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: SESSION_DURATION_MS / 1000,
    path: "/",
  });

  return NextResponse.json({ status: "ok" });
}

export async function DELETE() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
  return NextResponse.json({ status: "ok" });
}
