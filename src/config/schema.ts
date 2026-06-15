import { z } from "zod";
import { DbAdapterKind } from "../db";

// Zod schema for the daemon's operator `config.yaml`. Mirrors
// `config.example.yaml` at the repo root, which is the committed template
// (the live `config.yaml` is gitignored). See Vision §9 (configuration) and
// ARCHITECTURE.md for the field rationale.
//
// Optional fields carry `.default(...)` so a minimal config still produces a
// fully-populated, typed `Config` — callers never have to check a defaulted
// field for absence. Required fields have no default and fail validation when
// missing, yielding the actionable "which key, what was expected" message the
// loader surfaces.

// Concurrency caps for the scheduler. All three are global except
// `defaultRepoMax`, which seeds a per-repo cap when a repository omits its own
// `concurrencyMax`. See `src/engine/scheduler/concurrency.ts`.
const ConcurrencySchema = z
  .object({
    systemMax: z.number().int().positive(),
    githubApiMax: z.number().int().positive(),
    defaultRepoMax: z.number().int().positive().default(2),
  })
  .strict();

// One author-pattern → workflow mapping. `match` is a GitHub login or the `*`
// glob catch-all; `workflowId` names a workflow definition under `workflows/`.
const RepoWorkflowSchema = z
  .object({
    match: z.string().min(1),
    workflowId: z.string().min(1),
  })
  .strict();

// A repository the daemon watches. `concurrencyMax` is optional: when omitted
// the scheduler falls back to `concurrency.defaultRepoMax`, so it stays
// undefined here rather than defaulted, preserving the "not set" signal.
const RepositorySchema = z
  .object({
    id: z.string().min(1),
    enabled: z.boolean().default(true),
    concurrencyMax: z.number().int().positive().optional(),
    workflows: z.array(RepoWorkflowSchema).min(1),
  })
  .strict();

// Polling and scheduler cadence, in seconds.
const PollSchema = z
  .object({
    newPrIntervalSeconds: z.number().int().positive().default(60),
    schedulerIntervalSeconds: z.number().int().positive().default(5),
    heartbeatIntervalSeconds: z.number().int().positive().default(15),
  })
  .strict();

const EmulatorSchema = z
  .object({
    firestoreHost: z.string().min(1).default("localhost:8080"),
  })
  .strict();

// Data-store config. `emulator` is consulted only when `adapter` is
// `firebase-emulator` (see `createDb`), but parses regardless so a config that
// pre-declares it is accepted.
const DbSchema = z
  .object({
    adapter: z.enum(DbAdapterKind),
    logOverflowPath: z.string().min(1).default("./data/logs"),
    emulator: EmulatorSchema.optional(),
  })
  .strict();

// Commands collection — the Firestore-based operator → daemon control plane.
const CommandsSchema = z
  .object({
    collectionPath: z.string().min(1).default("commands"),
    pollIntervalSeconds: z.number().int().positive().default(5),
  })
  .strict();

// `poll` and `commands` are whole-section defaults: when the section is
// omitted, the section's inner field defaults are applied by parsing an empty
// object through the schema. (`.default({})` would short-circuit and store the
// literal `{}` without running the inner field defaults, leaving the fields
// undefined — so the default value is the parsed, fully-populated object.)
export const ConfigSchema = z
  .object({
    concurrency: ConcurrencySchema,
    repositories: z.array(RepositorySchema).min(1),
    poll: PollSchema.default(PollSchema.parse({})),
    db: DbSchema,
    commands: CommandsSchema.default(CommandsSchema.parse({})),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type RepositoryConfig = z.infer<typeof RepositorySchema>;
export type ConcurrencyConfig = z.infer<typeof ConcurrencySchema>;
