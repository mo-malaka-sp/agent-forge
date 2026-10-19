import { execFileSync } from "node:child_process";

const stackName = process.env.ENVIRONMENT_STACK_NAME || "agentforge-environment-runner";
const tableName = process.env.ENVIRONMENT_TABLE_NAME || "agentforge-environments";
const projectName = process.env.ENVIRONMENT_CODEBUILD_PROJECT || "agentforge-environment-runner";
const roleName = process.env.AMPLIFY_COMPUTE_ROLE_NAME || "";

execFileSync(
  "aws",
  [
    "cloudformation",
    "deploy",
    "--stack-name",
    stackName,
    "--template-file",
    "infra/agentforge-environment-runner.yaml",
    "--capabilities",
    "CAPABILITY_NAMED_IAM",
    "--parameter-overrides",
    `TableName=${tableName}`,
    `ProjectName=${projectName}`,
    `AmplifyComputeRoleName=${roleName}`,
  ],
  { stdio: "inherit" },
);

console.log(`Set ENVIRONMENT_TABLE_NAME=${tableName}`);
console.log(`Set ENVIRONMENT_CODEBUILD_PROJECT=${projectName}`);
console.log("Upload the repo zip to s3://<artifact-bucket>/agentforge/environment-runner.zip");
console.log("Tag the cross-account role and the ISC secret with agentforge=environment.");
