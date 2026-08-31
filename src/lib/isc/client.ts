import { getIscAccessToken } from "@/lib/isc/auth";
import { getIscBaseUrl, type IscConfig } from "@/lib/isc/config";

export type IscBodyMode = "json" | "json-patch" | "form" | "none";

export interface IscRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | boolean | undefined>;
  experimental?: boolean;
  /**
   * Override API version prefix (e.g. beta for task-status). Set to null for
   * APIs whose version is embedded in the path, such as /sources/v1.
   */
  apiVersion?: string | null;
  bodyMode?: IscBodyMode;
  /** Skip OAuth client credentials when a PAT or bearer token is already available. */
  accessToken?: string;
}

export async function iscRequest<T = unknown>(
  config: IscConfig,
  path: string,
  options: IscRequestOptions = {},
): Promise<T> {
  const token = options.accessToken?.trim() || (await getIscAccessToken(config));
  const baseUrl = getIscBaseUrl(config);
  const apiVersion =
    options.apiVersion === undefined ? config.apiVersion : options.apiVersion;
  const versionPrefix = apiVersion ? `/${apiVersion}` : "";
  const url = new URL(`${baseUrl}${versionPrefix}${path}`);

  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };

  if (options.experimental) {
    headers["X-SailPoint-Experimental"] = "true";
  }

  const bodyMode = options.bodyMode ?? "json";
  let requestBody: string | undefined;

  if (bodyMode === "json" && options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    requestBody = JSON.stringify(options.body);
  } else if (bodyMode === "json-patch" && options.body !== undefined) {
    headers["Content-Type"] = "application/json-patch+json";
    requestBody = JSON.stringify(options.body);
  } else if (bodyMode === "form" && options.body !== undefined) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    requestBody = new URLSearchParams(
      options.body as Record<string, string>,
    ).toString();
  }

  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: requestBody,
  });

  const text = await response.text();
  let data: unknown = null;

  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    throw new Error(
      `ISC ${options.method ?? "GET"} ${path} failed (${response.status}): ${text}`,
    );
  }

  return data as T;
}
