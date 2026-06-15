import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { StepType } from "@/db/schemas";
import { parseCondition } from "@/engine/routing";

// ---------------------------------------------------------------------------
// Workflow-definition YAML loader (vision §2.2, §4.4, §5; issue #122).
//
// Parses a workflow YAML file into a typed, validated step graph: a workflow
// id/version plus an ordered list of steps, each carrying
// `{ id, stepType, input template, routing rules }`. This is the piece that
// maps the routing DSL's `next` step-definition ids to concrete step specs,
// and that `fork`'s first-step factory and the "create the next step" path
// both consume.
//
// Validation is layered so that *every* defect is surfaced at load time —
// never deferred to the unlucky run that happens to exercise a bad branch:
//
//   1. Zod validates structure and that each `stepType` is a known StepType.
//   2. A cross-step pass confirms every routing `next` references a step in
//      the same workflow (or is terminal).
//   3. Each routing condition is parsed through the routing DSL parser from
//      #57, so unknown identifiers (e.g. a bare `verdict` instead of
//      `output.verdict`) become load-time errors.
//
// Every error is wrapped in a `WorkflowLoadError` annotated with the
// workflow id and (where applicable) the offending step id for diagnosis.
// ---------------------------------------------------------------------------

export class WorkflowLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowLoadError";
  }
}

// YAML `null` (or an omitted key) on a terminal route is normalized to
// `undefined` per the repo's prefer-undefined convention.
const RoutingRuleSchema = z
  .object({
    condition: z.string(),
    next: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
  })
  .strict();

const StepSchema = z
  .object({
    id: z.string().min(1),
    stepType: z.enum(StepType),
    input: z.record(z.string(), z.unknown()),
    routing: z.array(RoutingRuleSchema).min(1),
  })
  .strict();

const WorkflowGraphSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().nonnegative(),
    steps: z.array(StepSchema).min(1),
  })
  .strict();

export type RoutingRule = z.infer<typeof RoutingRuleSchema>;
export type WorkflowStep = z.infer<typeof StepSchema>;

// The validated step graph as parsed from YAML, before the raw source is
// attached.
type ValidatedGraph = z.infer<typeof WorkflowGraphSchema>;

// The parsed step graph. `source` is the verbatim YAML, retained for the
// `workflowDefinitions` reference-copy record (vision §3).
export interface WorkflowGraph extends ValidatedGraph {
  source: string;
}

export function loadWorkflow(source: string): WorkflowGraph {
  const raw = parseYamlSource(source);
  const parsed = WorkflowGraphSchema.safeParse(raw);
  if (!parsed.success) {
    const workflowId = extractWorkflowId(raw);
    throw new WorkflowLoadError(
      `Invalid workflow "${workflowId}": ${formatZodIssues(parsed.error, raw)}`,
    );
  }

  const graph = parsed.data;
  validateRouting(graph);
  return { ...graph, source };
}

function parseYamlSource(source: string): unknown {
  try {
    return parseYaml(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new WorkflowLoadError(`Failed to parse workflow YAML: ${detail}`);
  }
}

// Cross-step validation: confirm every `next` resolves to a defined step and
// every routing condition is a well-formed DSL expression. Both checks are
// reported with the workflow id + step id so a defect is traceable without
// re-reading the YAML.
function validateRouting(graph: ValidatedGraph): void {
  const stepIds = new Set(graph.steps.map((step) => step.id));

  for (const step of graph.steps) {
    for (const rule of step.routing) {
      if (rule.next !== undefined && !stepIds.has(rule.next)) {
        throw new WorkflowLoadError(
          `Workflow "${graph.id}" step "${step.id}" routes to unknown step ` +
            `"${rule.next}". \`next\` must reference a step in this workflow ` +
            `or be null (terminal).`,
        );
      }
      assertConditionParses(graph.id, step.id, rule.condition);
    }
  }
}

function assertConditionParses(
  workflowId: string,
  stepId: string,
  condition: string,
): void {
  try {
    parseCondition(condition);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new WorkflowLoadError(
      `Workflow "${workflowId}" step "${stepId}" has a malformed routing ` +
        `condition "${condition}": ${detail}`,
    );
  }
}

// Best-effort workflow id for error messages when the document fails the
// schema before `id` is validated. Falls back to "<unknown>".
function extractWorkflowId(raw: unknown): string {
  if (typeof raw === "object" && raw !== null && "id" in raw) {
    const { id } = raw;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return "<unknown>";
}

// Render Zod issues with the offending step id where the failing path points
// into the `steps` array, so structural errors (e.g. an unknown stepType)
// name the step rather than a bare array index.
function formatZodIssues(error: z.ZodError, raw: unknown): string {
  return error.issues
    .map((issue) => {
      const stepId = stepIdForPath(issue.path, raw);
      const location = stepId === undefined ? "" : ` (step "${stepId}")`;
      const path = issue.path.join(".");
      return `${path}${location}: ${issue.message}`;
    })
    .join("; ");
}

function stepIdForPath(
  path: readonly PropertyKey[],
  raw: unknown,
): string | undefined {
  if (path[0] !== "steps" || typeof path[1] !== "number") return undefined;
  if (typeof raw !== "object" || raw === null || !("steps" in raw)) {
    return undefined;
  }
  const { steps } = raw;
  if (!Array.isArray(steps)) return undefined;
  const step: unknown = steps[path[1]];
  if (typeof step === "object" && step !== null && "id" in step) {
    const { id } = step;
    if (typeof id === "string") return id;
  }
  return undefined;
}
