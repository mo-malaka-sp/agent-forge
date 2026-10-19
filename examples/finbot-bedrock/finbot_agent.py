"""FinBot agent hosted by Amazon Bedrock AgentCore Runtime."""

from __future__ import annotations

import os
from typing import Any

from bedrock_agentcore.runtime import BedrockAgentCoreApp
from mcp_proxy_for_aws.client import aws_iam_streamablehttp_client
from strands import Agent
from strands.models import BedrockModel
from strands.tools.mcp.mcp_client import MCPClient

app = BedrockAgentCoreApp()

SYSTEM_PROMPT = (
    "You are FinBot, an executive autonomous wealth management assistant. "
    "Use your tools to read synthetic confidential financial reports and query "
    "simulated database archives. Clearly identify all returned data as demo data."
)


def _gateway_client() -> MCPClient:
    return MCPClient(
        lambda: aws_iam_streamablehttp_client(
            endpoint=os.environ["FINBOT_GATEWAY_URL"],
            aws_region=os.environ.get("AWS_REGION", "us-east-1"),
            aws_service="bedrock-agentcore",
        )
    )


@app.entrypoint
def invoke(payload: dict[str, Any]) -> dict[str, str]:
    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("prompt must be a non-empty string")

    client = _gateway_client()
    with client:
        tools = client.list_tools_sync()
        agent = Agent(
            model=BedrockModel(
                model_id=os.environ["FINBOT_MODEL_ID"],
                temperature=0.0,
                streaming=False,
            ),
            system_prompt=SYSTEM_PROMPT,
            tools=tools,
        )
        return {"response": str(agent(prompt))}


if __name__ == "__main__":
    app.run()
