const DEFAULT_DOMAIN = "identitynow.com";
const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 45;

export interface SpConfigImportTarget {
  tenant: string;
  domain?: string;
  personalAccessToken: string;
}

export interface SpConfigImportResult {
  jobId: string;
  status: string;
  preview: boolean;
  connectorSlug: string;
  fileName: string;
  resultSummary?: string;
  dataset?: {
    id: string;
    createdDataset: boolean;
    createdResource: boolean;
    error?: string;
  };
}

function getBetaBaseUrl(target: SpConfigImportTarget): string {
  const domain = target.domain?.trim() || DEFAULT_DOMAIN;
  return `https://${target.tenant.trim()}.api.${domain}/beta`;
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function formatIscError(response: Response, body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    const detail = record.detail ?? record.message ?? record.error;
    if (typeof detail === "string" && detail.trim()) {
      return `ISC import failed (${response.status}): ${detail}`;
    }
  }

  const text = typeof body === "string" ? body : JSON.stringify(body);
  return `ISC import failed (${response.status}): ${text}`;
}

async function pollImportJob(
  baseUrl: string,
  token: string,
  jobId: string,
): Promise<{ status: string; body: unknown }> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const response = await fetch(`${baseUrl}/sp-config/import/${jobId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    const body = await parseResponse(response);
    if (!response.ok) {
      throw new Error(formatIscError(response, body));
    }

    const status =
      typeof body === "object" && body !== null
        ? String((body as Record<string, unknown>).status ?? "UNKNOWN")
        : "UNKNOWN";

    if (status === "COMPLETE" || status === "FAILED") {
      return { status, body };
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`ISC import job ${jobId} did not complete in time.`);
}

async function downloadImportResult(
  baseUrl: string,
  token: string,
  jobId: string,
): Promise<string | undefined> {
  const response = await fetch(`${baseUrl}/sp-config/import/${jobId}/download`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    return undefined;
  }

  const text = await response.text();
  return text.slice(0, 4_000);
}

export async function importSpConfigPackage(params: {
  target: SpConfigImportTarget;
  connectorSlug: string;
  fileName: string;
  configJson: string;
  preview: boolean;
}): Promise<SpConfigImportResult> {
  const baseUrl = getBetaBaseUrl(params.target);
  const token = params.target.personalAccessToken.trim();

  const form = new FormData();
  form.append(
    "data",
    new Blob([params.configJson], { type: "application/json" }),
    params.fileName,
  );

  const importUrl = new URL(`${baseUrl}/sp-config/import`);
  if (params.preview) {
    importUrl.searchParams.set("preview", "true");
  }

  const response = await fetch(importUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    body: form,
  });

  const startBody = await parseResponse(response);
  if (!response.ok) {
    throw new Error(formatIscError(response, startBody));
  }

  const jobId =
    typeof startBody === "object" && startBody !== null
      ? String((startBody as Record<string, unknown>).jobId ?? "")
      : "";

  if (!jobId) {
    throw new Error("ISC import did not return a jobId.");
  }

  const { status, body } = await pollImportJob(baseUrl, token, jobId);
  if (status === "FAILED") {
    const summary = await downloadImportResult(baseUrl, token, jobId);
    throw new Error(
      summary
        ? `ISC import failed for ${params.connectorSlug}: ${summary}`
        : `ISC import failed for ${params.connectorSlug}.`,
    );
  }

  const resultSummary = await downloadImportResult(baseUrl, token, jobId);

  return {
    jobId,
    status,
    preview: params.preview,
    connectorSlug: params.connectorSlug,
    fileName: params.fileName,
    resultSummary: resultSummary ?? JSON.stringify(body),
  };
}
