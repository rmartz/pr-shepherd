import { z } from "zod";
import { CommandStatus, CommandType } from "./enums";

// Schema for the `commands` collection — the operator → daemon control plane
// (ARCHITECTURE.md). The UI writes one document here per control action; the
// daemon's listener (`src/engine/commands`) picks it up via its admin-SDK
// subscription, applies the effect, and marks the document terminal.
//
// `payload` is the per-command-type argument bag. It is intentionally a loose
// record at the schema level — each command type names the keys it requires,
// and the listener validates them when it decodes the command. Keeping it
// permissive here means a malformed payload surfaces as a recorded `Failed`
// command (an acceptance requirement) rather than a write-time rejection the
// UI would have to special-case.
//
// `status` drives idempotency: a command is created `Pending`; the listener
// only acts on `Pending` documents and writes back `Handled` / `Failed`, so a
// re-delivered snapshot of an already-terminal command is a no-op.
export const CommandSchema = z
  .object({
    id: z.string(),
    type: z.enum(CommandType),
    payload: z.record(z.string(), z.unknown()),
    status: z.enum(CommandStatus),
    error: z.string().optional(),
    createdAt: z.number().int().nonnegative(),
    handledAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export type Command = z.infer<typeof CommandSchema>;
