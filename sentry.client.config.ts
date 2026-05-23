import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env["NEXT_PUBLIC_SENTRY_DSN"],

  // Sends IP addresses, cookies, and request headers. Off by default; opt in via
  // SENTRY_ENABLE_SENSITIVE_DATA=true (development only).
  sendDefaultPii:
    process.env.NODE_ENV === "development" &&
    process.env["NEXT_PUBLIC_SENTRY_ENABLE_SENSITIVE_DATA"] === "true",
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,
});
