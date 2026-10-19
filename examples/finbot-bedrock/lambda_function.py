"""AWS Lambda action-group tools for the synthetic FinBot demo."""

from __future__ import annotations

import os
from typing import Any

import boto3

DEMO_PREFIX = "finbot/"
DEFAULT_MNA_KEY = f"{DEMO_PREFIX}mna/demo-mna-deck.txt"


def _market_token_is_configured() -> bool:
    secret_id = os.environ["MARKET_DATA_SECRET_ID"]
    response = boto3.client("secretsmanager").get_secret_value(SecretId=secret_id)
    token = response.get("SecretString", "")
    if not token and response.get("SecretBinary"):
        token = "<binary-secret>"
    return bool(token)


def fetch_portfolio_summary(_: dict[str, str]) -> dict[str, Any]:
    return {
        "portfolio": "Apex Balanced Growth (synthetic)",
        "asOf": "2026-10-18",
        "marketValueUsd": 12_450_000,
        "allocation": {
            "equities": "58%",
            "fixedIncome": "29%",
            "alternatives": "8%",
            "cash": "5%",
        },
        "marketDataCredentialConfigured": _market_token_is_configured(),
        "notice": "Synthetic demo data. No external market API was called.",
    }


def query_mna_vault(values: dict[str, str]) -> dict[str, Any]:
    bucket = os.environ["FINBOT_DEMO_BUCKET"]
    key = values.get("documentKey", DEFAULT_MNA_KEY)
    if not key.startswith(DEMO_PREFIX):
        raise ValueError("Only synthetic objects under the finbot/ prefix are allowed.")

    response = boto3.client("s3").get_object(Bucket=bucket, Key=key)
    document = response["Body"].read().decode("utf-8")
    return {
        "bucket": bucket,
        "documentKey": key,
        "document": document,
        "classification": "SYNTHETIC-DEMO",
    }


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    custom = getattr(getattr(context, "client_context", None), "custom", {}) or {}
    tool_name = str(custom.get("bedrockAgentCoreToolName", ""))
    try:
        if tool_name.endswith("fetch_portfolio_summary"):
            return fetch_portfolio_summary(event)
        if tool_name.endswith("query_mna_vault"):
            return query_mna_vault(event)
        # A direct Lambda test can provide the unprefixed tool name explicitly.
        if event.get("_tool") == "fetch_portfolio_summary":
            return fetch_portfolio_summary(event)
        if event.get("_tool") == "query_mna_vault":
            return query_mna_vault(event)
        return {"error": f"Unsupported AgentCore tool: {tool_name or 'unknown'}"}
    except (ValueError, KeyError) as error:
        return {"error": str(error)}
    except Exception:
        # Do not return secrets, AWS errors, or stack traces to the model.
        return {"error": "The FinBot tool request failed."}
