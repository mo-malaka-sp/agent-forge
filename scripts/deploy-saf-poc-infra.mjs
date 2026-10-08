import { execFileSync } from "node:child_process";

const stackName = process.env.SAF_POC_STACK_NAME || "agentforge-saf-poc";
const tableName = process.env.SAF_POC_TABLE_NAME || "agentforge-saf-poc";
const roleName = process.env.AMPLIFY_COMPUTE_ROLE_NAME || "";

execFileSync(
  "aws",
  [
    "cloudformation",
    "deploy",
    "--stack-name",
    stackName,
    "--template-file",
    "infra/saf-poc-dynamodb.yaml",
    "--capabilities",
    "CAPABILITY_NAMED_IAM",
    "--parameter-overrides",
    `TableName=${tableName}`,
    `AmplifyComputeRoleName=${roleName}`,
  ],
  { stdio: "inherit" },
);

console.log(`Set SAF_POC_TABLE_NAME=${tableName} in the Amplify environment and redeploy.`);
