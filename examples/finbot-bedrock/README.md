# FinBot-Bedrock SAF + Entro demo

This example deploys FinBot to Amazon Bedrock AgentCore Runtime. The runtime
uses Strands and an IAM-authorized AgentCore Gateway whose MCP tools are backed
by Python 3.11 Lambda. All financial content and credentials are synthetic.

## Safety boundary

- S3 access is limited to `finbot/*` in one generated demo bucket.
- The Lambda reads only `apex/market_data_api_key`, which the deployer creates
  with a random synthetic value when absent.
- The AgentCore Runtime can invoke only the FinBot gateway, and that gateway
  can invoke only `FinBotToolExecutor`.
- The verification script prints caller and credential metadata, never AWS
  secret keys or session-token values.
- `apex-confidential-mna` and other real/confidential buckets are never read.

These constraints let the SAF/Entro demo show an agent, tools, data access, and
risk evidence without deploying a live wildcard-data-access vulnerability.

## Prerequisites

- Python 3.11+
- AWS credentials authorized to manage AgentCore, Lambda, IAM, S3,
  Secrets Manager, and CloudWatch Logs in a sandbox account
- Model access for `anthropic.claude-3-5-sonnet-20240620-v1:0`
- `pip` must be able to download Linux ARM64 wheels while packaging the
  AgentCore direct-code deployment.

## Deploy

Use your approved sandbox AWS profile through your normal AWS credential flow:

```bash
cd examples/finbot-bedrock
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
AWS_REGION=us-east-1 python deploy_agent.py
```

You can supply an existing synthetic bucket with `--bucket`. The deploy script
is idempotent: it updates the Lambda, Gateway target, and AgentCore Runtime
when they already exist.

The final JSON contains `agentRuntimeArn`, the Gateway URL and target ID, the
Lambda ARN, and the synthetic bucket/key. These identifiers are not credentials.

## Invoke and verify

```bash
AWS_REGION=us-east-1 \
FINBOT_RUNTIME_ARN=<agent-runtime-arn> \
python invoke_agent.py
```

The invocation asks FinBot to retrieve the synthetic M&A deck through Gateway
and summarize its fabricated bonus figures. Output includes the AgentCore
response, redacted STS credential metadata, caller identity, and recent
Runtime/Lambda logs.

## SAF/Entro demonstration

Register the deployed agent and its IAM/Lambda/S3 relationships in the SAF demo
tenant. Represent the rejected wildcard-access design as a simulated risk
finding in the demo data; do not broaden this deployment's actual IAM policy.
