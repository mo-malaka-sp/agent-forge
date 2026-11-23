#!/usr/bin/env bash
# Deploys infra/saf-poc-dynamodb.yaml: the SAF POC table, the Amplify IAM policies
# (DynamoDB and Secrets Manager for saved tenants), and the condition-run worker schedule.
#
# Edit the values below, or export them before running. No secrets go in this file.
# Run from anywhere:
#   bash scripts/deploy-saf-poc-infra.sh

set -euo pipefail

# Region of the Amplify app. Required.
export AWS_REGION="${AWS_REGION:-}"

# Name of the IAM role Amplify uses for SSR compute. The role name, not the ARN.
# Find it with: aws amplify get-app --app-id <APP_ID> --query app.iamServiceRoleArn --output text
export AMPLIFY_COMPUTE_ROLE_NAME="${AMPLIFY_COMPUTE_ROLE_NAME:-}"

# DynamoDB table name. Use the same value you set as SAF_POC_TABLE_NAME in Amplify.
export SAF_POC_TABLE_NAME="${SAF_POC_TABLE_NAME:-agentforge-saf-poc}"

# CloudFormation stack name.
export SAF_POC_STACK_NAME="${SAF_POC_STACK_NAME:-agentforge-saf-poc}"

# Worker schedule. Keep these equal to the values from the last deploy. If they are blank, the
# stack deletes the existing worker schedule.
export SAF_POC_WORKER_CALLBACK_URL="${SAF_POC_WORKER_CALLBACK_URL:-}"
export SAF_POC_WORKER_TOKEN="${SAF_POC_WORKER_TOKEN:-}"

if [[ -z "$AWS_REGION" ]]; then
  echo "Set AWS_REGION to the region of your Amplify app, e.g. us-east-1." >&2
  exit 1
fi
if [[ -z "$AMPLIFY_COMPUTE_ROLE_NAME" ]]; then
  echo "Set AMPLIFY_COMPUTE_ROLE_NAME to the Amplify SSR role name (not the ARN)." >&2
  exit 1
fi
if [[ -z "$SAF_POC_WORKER_CALLBACK_URL" ]]; then
  echo "Warning: SAF_POC_WORKER_CALLBACK_URL is blank. This deploy removes the worker schedule if one exists." >&2
fi

cd "$(dirname "$0")/.."

echo "Deploying stack $SAF_POC_STACK_NAME to $AWS_REGION"
echo "  table: $SAF_POC_TABLE_NAME"
echo "  Amplify role: $AMPLIFY_COMPUTE_ROLE_NAME"

node scripts/deploy-saf-poc-infra.mjs
