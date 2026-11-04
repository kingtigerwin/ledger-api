// The one place log lines are written, so secrets and email addresses are stripped no matter who logs what.
const SECRET_KEYS = new Set([
  "password",
  "passwordhash",
  "refreshtoken",
  "accesstoken",
  "authorization",
  "cookie",
  "cookies",
  "email",
]);

export function redact(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, SECRET_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : redact(v)]),
    );
  }
  return value;
}

export type LogEntry = { event: string } & Record<string, unknown>;
export type Logger = (entry: LogEntry, level?: "info" | "error") => void;

/** Writes one JSON line; Lambda's JSON log format picks it up as structured fields. */
export const log: Logger = (entry, level = "info") => {
  const line = JSON.stringify(redact(entry));
  if (level === "error") console.error(line);
  else console.log(line);
};
