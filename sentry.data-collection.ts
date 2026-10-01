// Header / query-param name fragments Sentry treats as identifying (IP and
// user forwarding). Mirrors the SDK v11 migration guide's equivalent of the
// v10 `sendDefaultPii: false` default.
const IDENTIFYING_KEYS = ["forwarded", "-ip", "remote-", "via", "-user"];

/**
 * Sentry `dataCollection` option for this app.
 *
 * SDK v11 replaced `sendDefaultPii` with `dataCollection`, and an unset
 * `dataCollection` now collects everything (IP addresses, cookies, headers,
 * bodies). To keep the previous privacy posture, sensitive collection stays
 * off unless explicitly opted in; when opted in, the SDK defaults apply
 * (the v11 equivalent of `sendDefaultPii: true`).
 */
export function sentryDataCollection(enableSensitiveData: boolean) {
  if (enableSensitiveData) return undefined;
  return {
    userInfo: false,
    cookies: false,
    httpHeaders: {
      request: { deny: IDENTIFYING_KEYS },
      response: { deny: IDENTIFYING_KEYS },
    },
    httpBodies: [],
    urlQueryParams: { deny: IDENTIFYING_KEYS },
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    queues: false,
  };
}
