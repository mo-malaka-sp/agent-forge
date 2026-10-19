#!/usr/bin/env python3
"""Deploy FinBot to AgentCore Runtime with Lambda tools behind Gateway."""

from __future__ import annotations

import argparse
import io
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import zipfile
from typing import Any

import boto3
from botocore.exceptions import ClientError

from iam_setup import ensure_gateway_role, ensure_lambda_role, ensure_runtime_role

RUNTIME_NAME = "FinBot_Bedrock"
GATEWAY_NAME = "FinBotGateway"
TARGET_NAME = "FinBotLambdaTools"
FUNCTION_NAME = "FinBotToolExecutor"
SECRET_NAME = "apex/market_data_api_key"
MODEL_ID = "anthropic.claude-3-5-sonnet-20240620-v1:0"
DEMO_DOCUMENT = """SYNTHETIC-DEMO — Apex Advisory M&A Brief

Target: Northstar Analytics
Illustrative transaction value: USD 420 million
Executive retention pool: USD 3.2 million
Illustrative bonuses: CEO USD 850,000; CFO USD 425,000; deal team USD 1,925,000.
This document contains fabricated data for the SAF + Entro demonstration only.
"""
TOOL_SCHEMA = [
    {
        "name": "fetch_portfolio_summary",
        "description": "Return a synthetic wealth-management portfolio summary.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "query_mna_vault",
        "description": "Read a synthetic M&A document from the restricted demo S3 prefix.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "documentKey": {
                    "type": "string",
                    "description": "S3 object key under the finbot/ prefix.",
                }
            },
        },
    },
]


def _create_bucket(s3: Any, bucket: str, region: str) -> None:
    try:
        s3.head_bucket(Bucket=bucket)
        return
    except ClientError as error:
        if error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") not in {403, 404}:
            raise
    request: dict[str, Any] = {"Bucket": bucket}
    if region != "us-east-1":
        request["CreateBucketConfiguration"] = {"LocationConstraint": region}
    s3.create_bucket(**request)
    s3.put_public_access_block(
        Bucket=bucket,
        PublicAccessBlockConfiguration={
            "BlockPublicAcls": True,
            "IgnorePublicAcls": True,
            "BlockPublicPolicy": True,
            "RestrictPublicBuckets": True,
        },
    )


def _ensure_secret(client: Any) -> str:
    try:
        return client.describe_secret(SecretId=SECRET_NAME)["ARN"]
    except client.exceptions.ResourceNotFoundException:
        return client.create_secret(
            Name=SECRET_NAME,
            Description="Synthetic market-data credential for the FinBot demo.",
            SecretString=secrets.token_urlsafe(32),
        )["ARN"]


def _source_zip(filename: str) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(Path(__file__).with_name(filename), filename)
    return buffer.getvalue()


def _ensure_lambda(
    client: Any,
    *,
    role_arn: str,
    bucket: str,
    secret_arn: str,
) -> str:
    environment = {"Variables": {
        "FINBOT_DEMO_BUCKET": bucket,
        "MARKET_DATA_SECRET_ID": secret_arn,
    }}
    package = _source_zip("lambda_function.py")
    try:
        arn = client.get_function(FunctionName=FUNCTION_NAME)["Configuration"]["FunctionArn"]
        client.update_function_code(FunctionName=FUNCTION_NAME, ZipFile=package, Publish=True)
        client.get_waiter("function_updated").wait(FunctionName=FUNCTION_NAME)
        client.update_function_configuration(
            FunctionName=FUNCTION_NAME,
            Runtime="python3.11",
            Role=role_arn,
            Handler="lambda_function.lambda_handler",
            Timeout=30,
            MemorySize=256,
            Environment=environment,
        )
        client.get_waiter("function_updated").wait(FunctionName=FUNCTION_NAME)
        return arn
    except client.exceptions.ResourceNotFoundException:
        response = client.create_function(
            FunctionName=FUNCTION_NAME,
            Runtime="python3.11",
            Role=role_arn,
            Handler="lambda_function.lambda_handler",
            Code={"ZipFile": package},
            Description="Synthetic tools for the SAF FinBot AgentCore demo.",
            Timeout=30,
            MemorySize=256,
            Publish=True,
            Environment=environment,
        )
        client.get_waiter("function_active_v2").wait(FunctionName=FUNCTION_NAME)
        return response["FunctionArn"]


def _named(items: list[dict[str, Any]], name: str) -> dict[str, Any] | None:
    return next((item for item in items if item.get("name") == name), None)


def _wait_gateway(client: Any, gateway_id: str) -> dict[str, Any]:
    for _ in range(90):
        gateway = client.get_gateway(gatewayIdentifier=gateway_id)
        if gateway["status"] == "READY":
            return gateway
        if gateway["status"] == "FAILED":
            raise RuntimeError(f"Gateway failed: {gateway.get('statusReasons', [])}")
        time.sleep(4)
    raise TimeoutError("Timed out waiting for AgentCore Gateway")


def _ensure_gateway(client: Any, role_arn: str) -> dict[str, Any]:
    current = _named(client.list_gateways(maxResults=100).get("items", []), GATEWAY_NAME)
    if current:
        gateway = client.update_gateway(
            gatewayIdentifier=current["gatewayId"],
            name=GATEWAY_NAME,
            roleArn=role_arn,
            protocolType="MCP",
            authorizerType="AWS_IAM",
            description="IAM-authorized MCP gateway for synthetic FinBot tools.",
        )
    else:
        gateway = client.create_gateway(
            name=GATEWAY_NAME,
            roleArn=role_arn,
            protocolType="MCP",
            authorizerType="AWS_IAM",
            description="IAM-authorized MCP gateway for synthetic FinBot tools.",
        )
    return _wait_gateway(client, gateway["gatewayId"])


def _ensure_target(client: Any, gateway_id: str, lambda_arn: str) -> dict[str, Any]:
    configuration = {
        "mcp": {
            "lambda": {
                "lambdaArn": lambda_arn,
                "toolSchema": {"inlinePayload": TOOL_SCHEMA},
            }
        }
    }
    credentials = [{"credentialProviderType": "GATEWAY_IAM_ROLE"}]
    current = _named(
        client.list_gateway_targets(
            gatewayIdentifier=gateway_id,
            maxResults=100,
        ).get("items", []),
        TARGET_NAME,
    )
    if current:
        return client.update_gateway_target(
            gatewayIdentifier=gateway_id,
            targetId=current["targetId"],
            name=TARGET_NAME,
            description="Lambda-backed synthetic financial tools.",
            targetConfiguration=configuration,
            credentialProviderConfigurations=credentials,
        )
    return client.create_gateway_target(
        gatewayIdentifier=gateway_id,
        name=TARGET_NAME,
        description="Lambda-backed synthetic financial tools.",
        targetConfiguration=configuration,
        credentialProviderConfigurations=credentials,
    )


def _runtime_package() -> bytes:
    root = Path(__file__).parent
    with tempfile.TemporaryDirectory(prefix="finbot-agentcore-") as temp:
        target = Path(temp)
        subprocess.run(
            [
                sys.executable,
                "-m",
                "pip",
                "install",
                "--quiet",
                "--target",
                str(target),
                "--platform",
                "manylinux2014_aarch64",
                "--implementation",
                "cp",
                "--python-version",
                "3.11",
                "--only-binary=:all:",
                "-r",
                str(root / "runtime_requirements.txt"),
            ],
            check=True,
        )
        (target / "finbot_agent.py").write_bytes((root / "finbot_agent.py").read_bytes())
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            for path in target.rglob("*"):
                if path.is_file():
                    archive.write(path, path.relative_to(target))
        return buffer.getvalue()


def _find_runtime(client: Any) -> dict[str, Any] | None:
    paginator = client.get_paginator("list_agent_runtimes")
    for page in paginator.paginate(PaginationConfig={"PageSize": 100}):
        for runtime in page.get("agentRuntimes", []):
            if runtime.get("agentRuntimeName") == RUNTIME_NAME:
                return runtime
    return None


def _wait_runtime(client: Any, runtime_id: str) -> dict[str, Any]:
    for _ in range(120):
        runtime = client.get_agent_runtime(agentRuntimeId=runtime_id)
        if runtime["status"] == "READY":
            return runtime
        if runtime["status"] in {"CREATE_FAILED", "UPDATE_FAILED"}:
            raise RuntimeError(f"Runtime failed: {runtime.get('failureReason', 'unknown')}")
        time.sleep(5)
    raise TimeoutError("Timed out waiting for AgentCore Runtime")


def _ensure_runtime(
    client: Any,
    *,
    role_arn: str,
    bucket: str,
    code_key: str,
    gateway_url: str,
    region: str,
) -> dict[str, Any]:
    artifact = {
        "codeConfiguration": {
            "code": {"s3": {"bucket": bucket, "prefix": code_key}},
            "runtime": "PYTHON_3_11",
            "entryPoint": ["finbot_agent.py"],
        }
    }
    values = {
        "agentRuntimeArtifact": artifact,
        "roleArn": role_arn,
        "networkConfiguration": {"networkMode": "PUBLIC"},
        "description": "FinBot wealth-management demo on AgentCore Runtime.",
        "protocolConfiguration": {"serverProtocol": "HTTP"},
        "environmentVariables": {
            "FINBOT_GATEWAY_URL": gateway_url,
            "FINBOT_MODEL_ID": MODEL_ID,
            "AWS_REGION": region,
        },
    }
    current = _find_runtime(client)
    if current:
        response = client.update_agent_runtime(
            agentRuntimeId=current["agentRuntimeId"],
            **values,
        )
    else:
        response = client.create_agent_runtime(
            agentRuntimeName=RUNTIME_NAME,
            **values,
        )
    return _wait_runtime(client, response["agentRuntimeId"])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", default=os.getenv("AWS_REGION", "us-east-1"))
    parser.add_argument("--bucket", help="Existing or new synthetic demo bucket.")
    args = parser.parse_args()

    session = boto3.Session(region_name=args.region)
    account_id = session.client("sts").get_caller_identity()["Account"]
    bucket = args.bucket or f"finbot-agentcore-demo-{account_id}-{args.region}"
    lambda_arn = f"arn:aws:lambda:{args.region}:{account_id}:function:{FUNCTION_NAME}"
    s3 = session.client("s3")
    secrets_client = session.client("secretsmanager")
    lambda_client = session.client("lambda")
    agentcore = session.client("bedrock-agentcore-control")

    _create_bucket(s3, bucket, args.region)
    s3.put_object(
        Bucket=bucket,
        Key="finbot/mna/demo-mna-deck.txt",
        Body=DEMO_DOCUMENT.encode(),
        ContentType="text/plain",
        ServerSideEncryption="AES256",
    )
    secret_arn = _ensure_secret(secrets_client)
    lambda_role = ensure_lambda_role(
        region=args.region,
        account_id=account_id,
        bucket_name=bucket,
        secret_arn=secret_arn,
    )
    function_arn = _ensure_lambda(
        lambda_client,
        role_arn=lambda_role,
        bucket=bucket,
        secret_arn=secret_arn,
    )
    gateway_role = ensure_gateway_role(
        region=args.region,
        account_id=account_id,
        lambda_arn=function_arn,
    )
    gateway = _ensure_gateway(agentcore, gateway_role)
    target = _ensure_target(agentcore, gateway["gatewayId"], function_arn)
    gateway_url = gateway["gatewayUrl"]
    if not gateway_url.endswith("/mcp"):
        gateway_url = f"{gateway_url.rstrip('/')}/mcp"

    runtime_role = ensure_runtime_role(
        region=args.region,
        account_id=account_id,
        gateway_arn=gateway["gatewayArn"],
        code_bucket=bucket,
        model_id=MODEL_ID,
    )
    code_key = "finbot/runtime/deployment_package.zip"
    s3.put_object(
        Bucket=bucket,
        Key=code_key,
        Body=_runtime_package(),
        ContentType="application/zip",
        ServerSideEncryption="AES256",
    )
    runtime = _ensure_runtime(
        agentcore,
        role_arn=runtime_role,
        bucket=bucket,
        code_key=code_key,
        gateway_url=gateway_url,
        region=args.region,
    )
    print(json.dumps({
        "agentRuntimeArn": runtime["agentRuntimeArn"],
        "agentRuntimeId": runtime["agentRuntimeId"],
        "gatewayArn": gateway["gatewayArn"],
        "gatewayUrl": gateway_url,
        "gatewayTargetId": target["targetId"],
        "lambdaArn": function_arn,
        "bucket": bucket,
        "documentKey": "finbot/mna/demo-mna-deck.txt",
    }, indent=2))


if __name__ == "__main__":
    main()
