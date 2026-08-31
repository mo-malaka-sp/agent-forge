import { z } from "zod";

import { deploymentProviderSchema } from "@/lib/validation/agent.schema";

export const iscRuntimeSchema = z
  .object({
    tenant: z.string().trim().min(1),
    client_id: z.string().trim().min(1),
    client_secret: z.string().trim().min(1),
    api_version: z.string().trim().optional(),
    domain: z.string().trim().optional(),
    sources: z
      .object({
        aws_bedrock: z.string().trim().optional(),
        gcp_vertex: z.string().trim().optional(),
        azure_ai_foundry: z.string().trim().optional(),
      })
      .partial()
      .optional(),
  })
  .optional();

export const iscSourcesUpdateSchema = z.object({
  sources: z
    .object({
      aws_bedrock: z.string().trim().optional(),
      gcp_vertex: z.string().trim().optional(),
      azure_ai_foundry: z.string().trim().optional(),
    })
    .partial()
    .optional(),
  mis_schemas: z
    .object({
      aws_bedrock: z.string().trim().optional(),
      gcp_vertex: z.string().trim().optional(),
      azure_ai_foundry: z.string().trim().optional(),
    })
    .partial()
    .optional(),
  dataset_ids: z
    .object({
      aws_bedrock: z.string().trim().optional(),
      gcp_vertex: z.string().trim().optional(),
      azure_ai_foundry: z.string().trim().optional(),
    })
    .partial()
    .optional(),
});

export const iscCredentialsUpdateSchema = z.object({
  tenant_url: z.string().trim().min(1, "Tenant URL is required"),
  client_id: z.string().trim().min(1, "Client ID is required"),
  client_secret: z.string().trim().optional(),
});

export const iscSourceVerifySchema = z.object({
  provider: deploymentProviderSchema,
  source_id: z.string().trim().min(1).optional(),
  isc_runtime: iscRuntimeSchema,
});
