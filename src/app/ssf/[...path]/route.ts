import { safError, safResult } from "@/lib/saf-poc/http";
import { dispatchSsf } from "@/lib/saf-poc/transmitter";
import { resolveBaseUrl } from "@/lib/url";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ path: string[] }> };

async function handle(request: Request, context: RouteContext) {
  try {
    const { path } = await context.params;
    let body: unknown = undefined;
    if (request.method !== "GET" && request.method !== "DELETE") {
      const text = await request.text();
      if (text.trim()) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          return safResult({ status: 400, body: { error: "Request body must be valid JSON." } });
        }
      }
    }
    const url = new URL(request.url);
    const query = Object.fromEntries(url.searchParams.entries());
    return safResult(
      await dispatchSsf({
        method: request.method,
        path: path.join("/"),
        query,
        body,
        authorization: request.headers.get("authorization") ?? "",
        publicUrl: resolveBaseUrl(request.headers),
      }),
    );
  } catch (error) {
    return safError(error);
  }
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
