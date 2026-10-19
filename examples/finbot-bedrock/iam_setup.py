#!/usr/bin/env python3
"""Create least-privilege IAM roles for the FinBot AgentCore demo."""

from __future__ import annotations

import json
import time
from typing import Any

import boto3

RUNTIME_ROLE_NAME = "FinBotAgentCoreRuntimeRole"
GATEWAY_ROLE_NAME = "FinBotAgentCoreGatewayRole"
LAMBDA_ROLE_NAME = "FinBotToolExecutorRole"


def _ensure_role(
    iam: Any,
    *,
    name: str,
    service: str,
    account_id: str,
    region: str,
) -> str:
    statement: dict[str, Any] = {
        "Effect": "Allow",
        "Principal": {"Service": service},
        "Action": "sts:AssumeRole",
    }
    if service == "bedrock-agentcore.amazonaws.com":
        statement["Condition"] = {
            "StringEquals": {"aws:SourceAccount": account_id},
            "ArnLike": {
                "aws:SourceArn": f"arn:aws:bedrock-agentcore:{region}:{account_id}:*"
            },
        }
    trust = {
        "Version": "2012-10-17",
        "Statement": [statement],
    }
    try:
        role = iam.get_role(RoleName=name)["Role"]
        iam.update_assume_role_policy(
            RoleName=name,
            PolicyDocument=json.dumps(trust),
        )
    except iam.exceptions.NoSuchEntityException:
        role = iam.create_role(
            RoleName=name,
            AssumeRolePolicyDocument=json.dumps(trust),
            Description="Execution role for the synthetic FinBot AgentCore demo.",
        )["Role"]
    return role["Arn"]


def ensure_lambda_role(
    *,
    region: str,
    account_id: str,
    bucket_name: str,
    secret_arn: str,
) -> str:
    iam = boto3.client("iam", region_name=region)
    role_arn = _ensure_role(
        iam,
        name=LAMBDA_ROLE_NAME,
        service="lambda.amazonaws.com",
        account_id=account_id,
        region=region,
    )
    policy = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "WriteFunctionLogs",
                "Effect": "Allow",
                "Action": [
                    "logs:CreateLogGroup",
                    "logs:CreateLogStream",
                    "logs:PutLogEvents",
                ],
                "Resource": "arn:aws:logs:*:*:*",
            },
            {
                "Sid": "ListSyntheticDemoBucket",
                "Effect": "Allow",
                "Action": ["s3:ListBucket"],
                "Resource": f"arn:aws:s3:::{bucket_name}",
                "Condition": {"StringLike": {"s3:prefix": ["finbot/*"]}},
            },
            {
                "Sid": "ReadSyntheticDemoDocuments",
                "Effect": "Allow",
                "Action": ["s3:GetObject"],
                "Resource": f"arn:aws:s3:::{bucket_name}/finbot/*",
            },
            {
                "Sid": "ReadMarketDataDemoSecret",
                "Effect": "Allow",
                "Action": ["secretsmanager:GetSecretValue"],
                "Resource": secret_arn,
            },
        ],
    }
    iam.put_role_policy(
        RoleName=LAMBDA_ROLE_NAME,
        PolicyName="FinBotToolExecutorPolicy",
        PolicyDocument=json.dumps(policy),
    )
    time.sleep(8)
    return role_arn


def ensure_gateway_role(
    *,
    region: str,
    account_id: str,
    lambda_arn: str,
) -> str:
    iam = boto3.client("iam", region_name=region)
    gateway_role_arn = _ensure_role(
        iam,
        name=GATEWAY_ROLE_NAME,
        service="bedrock-agentcore.amazonaws.com",
        account_id=account_id,
        region=region,
    )
    iam.put_role_policy(
        RoleName=GATEWAY_ROLE_NAME,
        PolicyName="FinBotGatewayTargetPolicy",
        PolicyDocument=json.dumps({
            "Version": "2012-10-17",
            "Statement": [{
                "Effect": "Allow",
                "Action": ["lambda:InvokeFunction"],
                "Resource": lambda_arn,
            }],
        }),
    )
    time.sleep(8)
    return gateway_role_arn


def ensure_runtime_role(
    *,
    region: str,
    account_id: str,
    gateway_arn: str,
    code_bucket: str,
    model_id: str,
) -> str:
    iam = boto3.client("iam", region_name=region)
    runtime_role_arn = _ensure_role(
        iam,
        name=RUNTIME_ROLE_NAME,
        service="bedrock-agentcore.amazonaws.com",
        account_id=account_id,
        region=region,
    )
    iam.put_role_policy(
        RoleName=RUNTIME_ROLE_NAME,
        PolicyName="FinBotAgentCoreRuntimePolicy",
        PolicyDocument=json.dumps({
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Sid": "InvokeModel",
                    "Effect": "Allow",
                    "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
                    "Resource": f"arn:aws:bedrock:{region}::foundation-model/{model_id}",
                },
                {
                    "Sid": "InvokeFinBotGateway",
                    "Effect": "Allow",
                    "Action": ["bedrock-agentcore:InvokeGateway"],
                    "Resource": gateway_arn,
                },
                {
                    "Sid": "ReadRuntimePackage",
                    "Effect": "Allow",
                    "Action": ["s3:GetObject"],
                    "Resource": f"arn:aws:s3:::{code_bucket}/finbot/runtime/*",
                },
                {
                    "Sid": "RuntimeTelemetry",
                    "Effect": "Allow",
                    "Action": [
                        "logs:CreateLogGroup",
                        "logs:CreateLogStream",
                        "logs:PutLogEvents",
                        "xray:PutTraceSegments",
                        "xray:PutTelemetryRecords",
                    ],
                    "Resource": "*",
                },
            ],
        }),
    )
    time.sleep(8)
    return runtime_role_arn


if __name__ == "__main__":
    raise SystemExit("Run deploy_agent.py; it resolves resource ARNs before creating roles.")
