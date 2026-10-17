import { adminPassword, adminUsername, safeEqual } from "@/lib/auth/credentials";

export const SESSION_COOKIE = "agentforge_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function sign(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(adminPassword()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function createSessionToken(username: string, now = Date.now()): Promise<string> {
  const payload = bytesToBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        u: username,
        exp: now + SESSION_MAX_AGE_SECONDS * 1000,
      }),
    ),
  );
  return `${payload}.${await sign(payload)}`;
}

export async function readSession(token: string | undefined, now = Date.now()): Promise<string | null> {
  if (!token) {
    return null;
  }
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) {
    return null;
  }
  const expected = await sign(payload);
  if (!safeEqual(signature, expected)) {
    return null;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload))) as {
      u?: unknown;
      exp?: unknown;
    };
    if (parsed.u !== adminUsername() || typeof parsed.exp !== "number" || parsed.exp <= now) {
      return null;
    }
    return parsed.u;
  } catch {
    return null;
  }
}
