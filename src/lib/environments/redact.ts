const SECRET_KEY = /secret|password|token|credential|authorization/i;
const SECRET_VALUE =
  /^(AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const EMBEDDED_SECRET =
  /AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

export function containsSecretMaterial(value: string): boolean {
  return SECRET_VALUE.test(value.trim());
}

export function redactSecrets<T>(value: T): T {
  return sanitize(value) as T;
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item));
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? value.replace(EMBEDDED_SECRET, "[redacted]") : value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SECRET_KEY.test(key) && key !== "secretRef" ? "[redacted]" : sanitize(entry),
    ]),
  );
}
