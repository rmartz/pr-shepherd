/**
 * Example service demonstrating the full mutation pattern for Realtime Database:
 *
 *   useMutation → API route → Firebase Admin SDK write → RTDB push → onValue → cache update
 *
 * This file is a scaffold — rename it to match your domain (e.g. `messages-service.ts`),
 * replace the `ExampleItem` type with your domain type, and delete this comment.
 *
 * Client-side usage:
 *
 *   const mutation = useMutation({ mutationFn: createExampleItem });
 *   mutation.mutate({ text: "hello" });
 *
 * The RTDB push triggered by the API route will fire the `useRealtimeValue` subscription
 * automatically, updating TanStack Query's cache without a manual invalidation.
 */

export interface ExampleItem {
  text: string;
  createdAt: number;
}

/**
 * Client-side service function — calls the API route which writes via Admin SDK.
 * The API route is the only path that writes to RTDB; the client never writes directly.
 */
export async function createExampleItem(
  payload: Pick<ExampleItem, "text">,
): Promise<void> {
  const response = await fetch("/api/example", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error("Failed to create item");
}

/*
 * Corresponding API route (src/app/api/example/route.ts) would look like:
 *
 *   import { push, ref } from "firebase-admin/database";
 *   import { getAdminDatabase } from "@/lib/firebase/admin";
 *   import { verifySession } from "@/server/utils/auth";
 *
 *   export async function POST(request: Request) {
 *     const { uid } = await verifySession();
 *     const { text } = (await request.json()) as { text: string };
 *     await push(ref(getAdminDatabase(), `users/${uid}/items`), {
 *       text,
 *       createdAt: Date.now(),
 *     });
 *     return new Response(null, { status: 201 });
 *   }
 *
 * The push updates RTDB, which fires the onValue subscription set up by
 * useRealtimeValue, which calls setQueryData to update the TanStack Query cache.
 */
