import { z } from "zod";

import { iscHostProblem, parseIscTenantUrl } from "@/lib/isc/tenant-url";
import {
  TENANT_FEATURES,
  type IscProfileInput,
  type TenantFeature,
} from "@/lib/isc/profiles-store";

const optionalText = z.string().optional();

const sourcesSchema = z
  .object({
    aws_bedrock: optionalText,
    gcp_vertex: optionalText,
    azure_ai_foundry: optionalText,
  })
  .partial();

const profileBodySchema = z.object({
  name: z.string().trim().min(1, "Name is required."),
  /** Either the tenant slug, or a pasted URL such as https://acme.identitynow-demo.com/. */
  tenant: z.string().trim().min(1, "SailPoint tenant is required."),
  domain: optionalText,
  apiVersion: optionalText,
  clientId: z.string().trim().min(1, "Client ID is required."),
  clientSecret: optionalText,
  sources: sourcesSchema.optional(),
  passwordClientId: optionalText,
  passwordClientSecret: optionalText,
  ownerId: optionalText,
  ownerName: optionalText,
  triggerName: optionalText,
  notifyEmail: optionalText,
});

export class ProfileBodyError extends Error {}

/**
 * Accepts a tenant slug or pasted URL. A pasted URL decides the domain, so a leftover value in
 * the Domain field cannot send the tenant to the wrong host.
 */
const FIELD_LABELS: Record<string, string> = {
  name: "Name",
  tenant: "SailPoint tenant",
  clientId: "Client ID",
  clientSecret: "Client secret",
};

export function parseProfileBody(raw: unknown): IscProfileInput {
  const parsed = profileBodySchema.safeParse(raw);
  if (!parsed.success) {
    const messages = parsed.error.issues.map((issue) => {
      const field = String(issue.path[0] ?? "");
      if (issue.code === "invalid_type" && FIELD_LABELS[field]) {
        return `${FIELD_LABELS[field]} is required.`;
      }
      return issue.message;
    });
    throw new ProfileBodyError(messages.join(" "));
  }
  const body = parsed.data;
  let tenant = body.tenant.trim();
  let domain = body.domain?.trim() || "";
  if (tenant.includes(".") || tenant.includes("/")) {
    const fromUrl = parseIscTenantUrl(tenant);
    if (!fromUrl) {
      throw new ProfileBodyError("Enter a valid tenant URL, e.g. https://acme.identitynow-demo.com/");
    }
    tenant = fromUrl.tenant;
    domain = fromUrl.domain;
  }
  const hostProblem = iscHostProblem(tenant, domain || "identitynow.com");
  if (hostProblem) {
    throw new ProfileBodyError(hostProblem);
  }
  return {
    name: body.name,
    tenant,
    domain: domain || undefined,
    apiVersion: body.apiVersion?.trim() || undefined,
    clientId: body.clientId,
    clientSecret: body.clientSecret?.trim() || undefined,
    sources: body.sources,
    passwordClientId: body.passwordClientId?.trim() || undefined,
    passwordClientSecret: body.passwordClientSecret?.trim() || undefined,
    ownerId: body.ownerId?.trim() || undefined,
    ownerName: body.ownerName?.trim() || undefined,
    triggerName: body.triggerName?.trim() || undefined,
    notifyEmail: body.notifyEmail?.trim() || undefined,
  };
}

const bindingSchema = z.object({
  feature: z.enum(TENANT_FEATURES),
  profileId: z.string().trim().min(1).nullable(),
});

export function parseBindingBody(raw: unknown): { feature: TenantFeature; profileId: string | null } {
  const parsed = bindingSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProfileBodyError("Choose a feature and a saved tenant, or none.");
  }
  return parsed.data;
}
