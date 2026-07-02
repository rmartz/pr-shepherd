import {
  GithubRateLimitError,
  type GithubReadTransport,
} from "@/engine/derivation";
import {
  defaultGhExec,
  isRateLimitResult,
  type GhExec,
  type GhResult,
} from "./ghExec";

// ---------------------------------------------------------------------------
// Production `GithubReadTransport` (issue #290).
//
// Implements the read seam the `derive_pr_state` snapshot fetcher (#95) depends
// on, backed by the `gh` CLI:
//   - `graphql` sends `{ query, variables }` to the GraphQL endpoint via
//     `gh api graphql --input -` and returns the unwrapped `data`.
//   - `restPaginate` runs `gh api --paginate <path>` and returns the flattened
//     array of results.
//
// REQUIRED CONTRACT (#140): a rate-limit rejection MUST surface as a
// `GithubRateLimitError` so `withRateLimitRetry` engages its backoff. Every
// path here routes a rate-limited `gh` result through `throwIfRateLimited`
// before any other error handling.
// ---------------------------------------------------------------------------

export function createGithubReadTransport(
  exec: GhExec = defaultGhExec,
): GithubReadTransport {
  return {
    graphql: async <T = unknown>(
      query: string,
      variables: Record<string, unknown>,
    ): Promise<T> => {
      const result = await exec({
        args: ["api", "graphql", "--input", "-"],
        stdin: JSON.stringify({ query, variables }),
      });
      throwIfRateLimited(result);
      if (result.exitCode !== 0) {
        throw new Error(
          `gh api graphql failed (exit ${String(result.exitCode)}): ${result.stderr.trim()}`,
        );
      }
      const parsed = JSON.parse(result.stdout) as {
        data?: T;
        errors?: unknown;
      };
      if (parsed.errors !== undefined) {
        throw new Error(`GraphQL errors: ${JSON.stringify(parsed.errors)}`);
      }
      if (parsed.data === undefined) {
        throw new Error(
          `GraphQL response missing 'data' field: ${result.stdout.slice(0, 200)}`,
        );
      }
      return parsed.data;
    },

    restPaginate: async <T = unknown>(
      path: string,
      params?: Record<string, string | number>,
    ): Promise<T[]> => {
      const result = await exec({
        args: ["api", "--paginate", buildPath(path, params)],
      });
      throwIfRateLimited(result);
      if (result.exitCode !== 0) {
        throw new Error(
          `gh api ${path} failed (exit ${String(result.exitCode)}): ${result.stderr.trim()}`,
        );
      }
      return JSON.parse(result.stdout) as T[];
    },
  };
}

function throwIfRateLimited(result: GhResult): void {
  if (isRateLimitResult(result)) {
    throw new GithubRateLimitError(`gh rate limit: ${result.stderr.trim()}`);
  }
}

// Append REST query params to the path, preserving any existing query string.
function buildPath(
  path: string,
  params?: Record<string, string | number>,
): string {
  if (params === undefined || Object.keys(params).length === 0) {
    return path;
  }
  const query = Object.entries(params)
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
    )
    .join("&");
  return path.includes("?") ? `${path}&${query}` : `${path}?${query}`;
}
