// Temporary shared login. Override with AGENTFORGE_ADMIN_USERNAME and AGENTFORGE_ADMIN_PASSWORD.
const DEFAULT_USERNAME = "agentforge";
const DEFAULT_PASSWORD = "Forge-demo-17";

export function adminUsername(): string {
  return process.env.AGENTFORGE_ADMIN_USERNAME?.trim() || DEFAULT_USERNAME;
}

export function adminPassword(): string {
  return process.env.AGENTFORGE_ADMIN_PASSWORD?.trim() || DEFAULT_PASSWORD;
}

export function safeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.max(a.length, b.length);
  let mismatch = a.length === b.length ? 0 : 1;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return mismatch === 0;
}

export function credentialsMatch(username: string, password: string): boolean {
  return safeEqual(username, adminUsername()) && safeEqual(password, adminPassword());
}
