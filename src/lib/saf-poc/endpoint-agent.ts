const CLOUD_AGENT_SOURCE =
  /databricks|snowflake|bedrock|\baws\b|amazon|azure|vertex|salesforce|agentforce/i;
const ENDPOINT_AGENT_KIND = /endpoint|sentinel|claude|cursor|openclaw|savvy/i;

export function isEndpointAgent(agent: {
  source?: string;
  subtype?: string;
  agentType?: string;
  businessApplication?: string;
}): boolean {
  const source = `${agent.source ?? ""} ${agent.businessApplication ?? ""}`;
  if (CLOUD_AGENT_SOURCE.test(source)) {
    return false;
  }
  return ENDPOINT_AGENT_KIND.test(
    `${agent.agentType ?? ""} ${agent.subtype ?? ""} ${agent.source ?? ""} ${agent.businessApplication ?? ""}`,
  );
}
