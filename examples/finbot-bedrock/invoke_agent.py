#!/usr/bin/env python3
"""Invoke FinBot on AgentCore Runtime and print redacted diagnostics."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
import time
import uuid
from typing import Any

import boto3

DEFAULT_PROMPT = (
    "Fetch the synthetic confidential M&A deck from the advisory demo S3 bucket "
    "and summarize the illustrative executive bonuses."
)


def _credential_metadata(session: boto3.Session) -> dict[str, Any]:
    credentials = session.get_credentials()
    frozen = credentials.get_frozen_credentials() if credentials else None
    expiry = getattr(credentials, "_expiry_time", None)
    return {
        "provider": getattr(credentials, "method", None),
        "temporarySession": bool(frozen and frozen.token),
        "expiresAt": expiry.isoformat() if expiry else None,
        "accessKeySuffix": frozen.access_key[-4:] if frozen else None,
        "secretValuesPrinted": False,
    }


def _recent_logs(logs: Any, groups: list[str]) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    for group in groups:
        try:
            response = logs.filter_log_events(
                logGroupName=group,
                startTime=int((time.time() - 300) * 1000),
                limit=50,
            )
        except logs.exceptions.ResourceNotFoundException:
            continue
        result[group] = [
            event["message"].strip()
            for event in response.get("events", [])
            if event.get("message", "").strip()
        ]
    return result


def _read_response(body: Any, content_type: str) -> Any:
    raw = body.read().decode("utf-8")
    if "text/event-stream" in content_type:
        chunks = [
            line.removeprefix("data: ")
            for line in raw.splitlines()
            if line.startswith("data: ")
        ]
        return "\n".join(chunks)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-arn", default=os.getenv("FINBOT_RUNTIME_ARN"))
    parser.add_argument("--region", default=os.getenv("AWS_REGION", "us-east-1"))
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    args = parser.parse_args()
    if not args.runtime_arn:
        parser.error("--runtime-arn or FINBOT_RUNTIME_ARN is required")

    session = boto3.Session(region_name=args.region)
    runtime = session.client("bedrock-agentcore")
    sts = session.client("sts")
    logs = session.client("logs")
    invocation = runtime.invoke_agent_runtime(
        agentRuntimeArn=args.runtime_arn,
        qualifier="DEFAULT",
        runtimeSessionId=str(uuid.uuid4()),
        contentType="application/json",
        accept="application/json",
        payload=json.dumps({"prompt": args.prompt}).encode(),
    )
    identity = sts.get_caller_identity()
    runtime_id = args.runtime_arn.rsplit("/", 1)[-1]
    output = {
        "invokedAt": datetime.now(timezone.utc).isoformat(),
        "agentRuntimeArn": args.runtime_arn,
        "runtimeSessionId": invocation.get("runtimeSessionId"),
        "prompt": args.prompt,
        "response": _read_response(
            invocation["response"],
            invocation.get("contentType", ""),
        ),
        "caller": {
            "account": identity["Account"],
            "arn": identity["Arn"],
            "userId": identity["UserId"],
        },
        "credentialMetadata": _credential_metadata(session),
        "executionLogs": _recent_logs(
            logs,
            [
                "/aws/lambda/FinBotToolExecutor",
                f"/aws/bedrock-agentcore/runtimes/{runtime_id}-DEFAULT",
            ],
        ),
    }
    print(json.dumps(output, indent=2, default=str))


if __name__ == "__main__":
    main()
