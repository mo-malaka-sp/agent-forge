/**
 * Checks that a SailPoint tenant accepts a client and answers the API paths AgentForge uses.
 * Ported from scripts/test-isc-connection.mjs. Never returns the token or the secret.
 */
import type { ConnectionCheck, ConnectionStep } from "@/lib/isc/profile-types";
import { iscHostProblem } from "@/lib/isc/tenant-url";

export type { ConnectionCheck, ConnectionStep } from "@/lib/isc/profile-types";

export type ConnectionInput = {
  tenant: string;
  domain: string;
  clientId: string;
  clientSecret: string;
};

export const AGENTFORGE_PATHS = [
  "/sources/v1?limit=1",
  "/identity-profiles/v1?limit=1",
  "/entitlements/v1?limit=1",
  "/roles/v1?limit=1",
  "/accounts/v1?limit=1",
  "/identities/v1?limit=1",
  "/machine-identities/v1?limit=1",
  "/v2026/machine-identities?limit=1",
  "/v3/roles?limit=1",
] as const;

/** Test Drive needs these two sources. Reported, but they do not fail the check. */
export const TESTDRIVE_SOURCES = ["TestDriveUsers", "IdentityNow"] as const;

const TIMEOUT_MS = 15_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function looksLikeHtml(text: string): boolean {
  return text.trimStart().startsWith("<");
}

function pageTitle(text: string): string {
  return text.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() ?? "";
}

function redirectStep(id: string, label: string, response: Response, required: boolean): ConnectionStep {
  const location = response.headers.get("location") ?? "another address";
  return {
    id,
    label,
    ok: false,
    required,
    detail: `Redirected to ${location}. This tenant is not answering API calls. Check the tenant name and domain.`,
  };
}

export function apiBaseFor(tenant: string, domain: string): string {
  return `https://${tenant.trim()}.api.${domain.trim()}`;
}

export async function checkIscConnection(
  input: ConnectionInput,
  fetchImpl: FetchLike = fetch,
): Promise<ConnectionCheck> {
  const host = apiBaseFor(input.tenant, input.domain);
  const steps: ConnectionStep[] = [];
  const finish = (): ConnectionCheck => ({
    ok: steps.filter((step) => step.required).every((step) => step.ok),
    host,
    steps,
    checkedAt: new Date().toISOString(),
  });

  // The secret is sent to this host, so check the domain before any request is made.
  const hostProblem = iscHostProblem(input.tenant, input.domain);
  if (hostProblem) {
    steps.push({ id: "domain", label: "Tenant domain", ok: false, required: true, detail: hostProblem });
    return finish();
  }

  if (!input.tenant.trim() || !input.clientId.trim() || !input.clientSecret.trim()) {
    steps.push({
      id: "input",
      label: "Input",
      ok: false,
      required: true,
      detail: "Tenant, client ID and client secret are all required.",
    });
    return finish();
  }

  // 1. Token. redirect: "manual" so a maintenance redirect is reported, not followed.
  let accessToken = "";
  try {
    const response = await fetchImpl(`${host}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: input.clientId.trim(),
        client_secret: input.clientSecret.trim(),
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    if (response.status >= 300 && response.status < 400) {
      steps.push(redirectStep("token", "Token", response, true));
      return finish();
    }
    if (looksLikeHtml(text)) {
      steps.push({
        id: "token",
        label: "Token",
        ok: false,
        required: true,
        detail: `Returned a web page (${pageTitle(text) || "no title"}) instead of a token. Check the tenant name and domain.`,
      });
      return finish();
    }
    if (!response.ok) {
      steps.push({
        id: "token",
        label: "Token",
        ok: false,
        required: true,
        detail: `HTTP ${response.status}. The client ID or secret was rejected.`,
      });
      return finish();
    }
    try {
      accessToken = (JSON.parse(text) as { access_token?: string }).access_token ?? "";
    } catch {
      accessToken = "";
    }
    if (!accessToken) {
      steps.push({
        id: "token",
        label: "Token",
        ok: false,
        required: true,
        detail: "The token response did not include an access token.",
      });
      return finish();
    }
    steps.push({ id: "token", label: "Token", ok: true, required: true, detail: "Client accepted." });
  } catch (error) {
    steps.push({
      id: "token",
      label: "Token",
      ok: false,
      required: true,
      detail: `Could not reach ${host}: ${error instanceof Error ? error.message : "unknown error"}`,
    });
    return finish();
  }

  const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };

  // 2. Sources. Names only.
  try {
    const response = await fetchImpl(`${host}/v3/sources?limit=250`, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok || looksLikeHtml(text)) {
      steps.push({
        id: "sources",
        label: "Sources (v3)",
        ok: false,
        required: true,
        detail: `HTTP ${response.status}. The client signed in but the API refused the call. Check its roles.`,
      });
      return finish();
    }
    const names = (JSON.parse(text) as Array<{ name?: string }>)
      .map((source) => source.name ?? "")
      .filter(Boolean);
    steps.push({
      id: "sources",
      label: "Sources (v3)",
      ok: true,
      required: true,
      detail: `${names.length} source(s) in this tenant.`,
    });
    for (const name of TESTDRIVE_SOURCES) {
      const found = names.includes(name);
      steps.push({
        id: `source:${name}`,
        label: `Source ${name}`,
        ok: found,
        required: false,
        detail: found ? "Found." : "Missing. Test Drive setup needs this source.",
      });
    }
  } catch (error) {
    steps.push({
      id: "sources",
      label: "Sources (v3)",
      ok: false,
      required: true,
      detail: error instanceof Error ? error.message : "Sources request failed.",
    });
    return finish();
  }

  // 3. The paths AgentForge calls. A web page here, while /v3 works, means the tenant does not
  // serve these API versions.
  for (const path of AGENTFORGE_PATHS) {
    try {
      const response = await fetchImpl(`${host}${path}`, {
        headers: { ...headers, "X-SailPoint-Experimental": "true" },
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await response.text();
      if (response.status >= 300 && response.status < 400) {
        steps.push(redirectStep(`path:${path}`, path, response, true));
        continue;
      }
      if (looksLikeHtml(text)) {
        steps.push({
          id: `path:${path}`,
          label: path,
          ok: false,
          required: true,
          detail: `Web page${pageTitle(text) ? ` "${pageTitle(text)}"` : ""} instead of API data.`,
        });
        continue;
      }
      steps.push({
        id: `path:${path}`,
        label: path,
        ok: response.ok,
        required: true,
        detail: response.ok ? "JSON." : `HTTP ${response.status}.`,
      });
    } catch (error) {
      steps.push({
        id: `path:${path}`,
        label: path,
        ok: false,
        required: true,
        detail: error instanceof Error ? error.message : "Request failed.",
      });
    }
  }

  return finish();
}

export function summarizeConnectionCheck(check: ConnectionCheck): string {
  const failed = check.steps.filter((step) => step.required && !step.ok);
  if (check.ok) {
    return `Connected to ${check.host}. All ${check.steps.filter((step) => step.required).length} required checks passed.`;
  }
  return `${failed.length} check(s) failed on ${check.host}. First: ${failed[0]?.label ?? "unknown"}, ${failed[0]?.detail ?? ""}`;
}
