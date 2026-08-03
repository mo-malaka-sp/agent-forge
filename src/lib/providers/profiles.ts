export const DEPLOYMENT_PROVIDERS = {
  aws_bedrock: {
    label: "AWS Bedrock",
    cloud: "aws",
    infrastructure: "bedrock",
    connectorSlug: "aws-bedrock",
    nativeStatusActive: "PREPARED",
    misSchemaId: "bedrock-agent",
    demoHeroAgentId: "agt_demo_aws_bedrock",
    defaultConfig: {
      region: "us-east-1",
      account_id: "123456789012",
      foundation_model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      agent_alias: "prod",
    },
  },
  gcp_vertex: {
    label: "Google Cloud Vertex AI",
    cloud: "gcp",
    infrastructure: "vertex_ai",
    connectorSlug: "gcp-vertex",
    nativeStatusActive: "ACTIVE",
    misSchemaId: "gcp-agent",
    demoHeroAgentId: "agt_demo_gcp_vertex",
    defaultConfig: {
      project_id: "demo-ai-governance",
      location: "us-central1",
    },
  },
  azure_ai_foundry: {
    label: "Microsoft Azure AI Foundry",
    cloud: "azure",
    infrastructure: "ai_foundry",
    connectorSlug: "azure-ai-foundry",
    nativeStatusActive: "Succeeded",
    misSchemaId: "foundry-agent",
    demoHeroAgentId: "agt_demo_azure_foundry",
    defaultConfig: {
      subscription_id: "00000000-0000-0000-0000-000000000001",
      resource_group: "rg-ai-agents",
      workspace: "foundry-demo",
      location: "eastus",
    },
  },
} as const;

export type DeploymentProvider = keyof typeof DEPLOYMENT_PROVIDERS;

export const DEPLOYMENT_PROVIDER_VALUES = Object.keys(
  DEPLOYMENT_PROVIDERS,
) as DeploymentProvider[];

export type DeploymentConfig = Record<string, string>;
