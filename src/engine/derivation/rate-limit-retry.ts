// ---------------------------------------------------------------------------
// GitHub rate-limit retry wrapper used by the snapshot fetcher (#95).
// ---------------------------------------------------------------------------

export class GithubRateLimitError extends Error {
  constructor(message = "GitHub rate limit hit") {
    super(message);
    this.name = "GithubRateLimitError";
  }
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  backoffMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof GithubRateLimitError && attempt < retries) {
        await sleep(backoffMs * (attempt + 1));
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
}
