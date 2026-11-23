import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

/**
 * Where saved tenants keep their client secrets. The IAM policy in
 * infra/saf-poc-dynamodb.yaml grants access to this prefix only.
 */
export const PROFILE_SECRET_PREFIX = "agentforge/isc-profile/";

export type ProfileSecretKind = "client" | "password-client";

export interface ProfileSecretVault {
  put(name: string, value: string): Promise<void>;
  get(name: string): Promise<string | null>;
  delete(name: string): Promise<void>;
}

export function profileSecretName(profileId: string, kind: ProfileSecretKind): string {
  return `${PROFILE_SECRET_PREFIX}${profileId}/${kind}`;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

export function createSecretsManagerVault(
  client: Pick<SecretsManagerClient, "send"> = new SecretsManagerClient({}),
): ProfileSecretVault {
  return {
    async put(name, value) {
      try {
        await client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
      } catch (error) {
        if (errorName(error) !== "ResourceNotFoundException") throw error;
        await client.send(new CreateSecretCommand({ Name: name, SecretString: value }));
      }
    },
    async get(name) {
      try {
        const response = await client.send(new GetSecretValueCommand({ SecretId: name }));
        return response.SecretString ?? null;
      } catch (error) {
        if (errorName(error) === "ResourceNotFoundException") return null;
        throw error;
      }
    },
    async delete(name) {
      try {
        await client.send(
          new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true }),
        );
      } catch (error) {
        if (errorName(error) !== "ResourceNotFoundException") throw error;
      }
    },
  };
}

let override: ProfileSecretVault | null | undefined;
let cachedVault: ProfileSecretVault | null = null;

/** Test-only: replace the vault. `null` means "no vault" (plaintext local storage). */
export function setProfileSecretVaultForTests(vault: ProfileSecretVault | null | undefined): void {
  override = vault;
}

/**
 * Secrets go to Secrets Manager whenever a table is configured, which is the deployed
 * case. Without a table, local development keeps them in the local store file.
 */
export function profileSecretVault(): ProfileSecretVault | null {
  if (override !== undefined) return override;
  if (!process.env.SAF_POC_TABLE_NAME?.trim()) return null;
  cachedVault ??= createSecretsManagerVault();
  return cachedVault;
}
