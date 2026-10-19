import fs from "node:fs";
import path from "node:path";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

import type { EnvironmentRecord, EnvironmentRun } from "@/lib/environments/types";

export interface EnvironmentStore {
  saveEnvironment(record: EnvironmentRecord): Promise<void>;
  getEnvironment(id: string): Promise<EnvironmentRecord | null>;
  listEnvironments(): Promise<EnvironmentRecord[]>;
  saveRun(run: EnvironmentRun): Promise<void>;
  getRun(environmentId: string, runId: string): Promise<EnvironmentRun | null>;
  listRuns(environmentId: string): Promise<EnvironmentRun[]>;
}

const PARTITION = "ENVIRONMENT";
let cached: EnvironmentStore | null = null;

export function environmentTableName(): string | undefined {
  return process.env.ENVIRONMENT_TABLE_NAME?.trim() || undefined;
}

export function getEnvironmentStore(): EnvironmentStore {
  if (!cached) {
    const table = environmentTableName();
    cached = table
      ? createEnvironmentDynamoStore(table)
      : createEnvironmentFileStore(path.join(process.cwd(), "data", "environments.json"));
  }
  return cached;
}

export function resetEnvironmentStoreForTests(): void {
  cached = null;
}

export function useEnvironmentStore(store: EnvironmentStore): void {
  cached = store;
}

export function createMemoryEnvironmentStore(): EnvironmentStore {
  const environments = new Map<string, EnvironmentRecord>();
  const runs = new Map<string, EnvironmentRun>();
  return {
    async saveEnvironment(record) {
      environments.set(record.id, record);
    },
    async getEnvironment(id) {
      return environments.get(id) ?? null;
    },
    async listEnvironments() {
      return [...environments.values()];
    },
    async saveRun(run) {
      runs.set(`${run.environmentId}#${run.id}`, run);
    },
    async getRun(environmentId, runId) {
      return runs.get(`${environmentId}#${runId}`) ?? null;
    },
    async listRuns(environmentId) {
      return [...runs.values()].filter((run) => run.environmentId === environmentId);
    },
  };
}

export function createEnvironmentDynamoStore(
  tableName: string,
  client = DynamoDBDocumentClient.from(new DynamoDBClient({})),
): EnvironmentStore {
  return {
    async saveEnvironment(record) {
      await put(client, tableName, `env#${record.id}`, record);
    },
    async getEnvironment(id) {
      return get<EnvironmentRecord>(client, tableName, `env#${id}`);
    },
    async listEnvironments() {
      return list<EnvironmentRecord>(client, tableName, "env#");
    },
    async saveRun(run) {
      await put(client, tableName, `run#${run.environmentId}#${run.id}`, run);
    },
    async getRun(environmentId, runId) {
      return get<EnvironmentRun>(client, tableName, `run#${environmentId}#${runId}`);
    },
    async listRuns(environmentId) {
      return list<EnvironmentRun>(client, tableName, `run#${environmentId}#`);
    },
  };
}

async function put(
  client: DynamoDBDocumentClient,
  tableName: string,
  key: string,
  value: unknown,
): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: tableName,
      Item: { pk: PARTITION, sk: key, value, updatedAt: new Date().toISOString() },
    }),
  );
}

async function get<T>(
  client: DynamoDBDocumentClient,
  tableName: string,
  key: string,
): Promise<T | null> {
  const response = await client.send(
    new GetCommand({ TableName: tableName, Key: { pk: PARTITION, sk: key } }),
  );
  return (response.Item?.value as T | undefined) ?? null;
}

async function list<T>(
  client: DynamoDBDocumentClient,
  tableName: string,
  prefix: string,
): Promise<T[]> {
  const response = await client.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": PARTITION, ":prefix": prefix },
    }),
  );
  return (response.Items ?? []).map((item) => item.value as T);
}

type FileState = Record<string, { value: unknown }>;

export function createEnvironmentFileStore(filePath: string): EnvironmentStore {
  const read = (): FileState =>
    fs.existsSync(filePath) ? (JSON.parse(fs.readFileSync(filePath, "utf8")) as FileState) : {};
  const write = (state: FileState): void => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
  };
  const values = <T>(prefix: string): T[] =>
    Object.entries(read())
      .filter(([key]) => key.startsWith(prefix))
      .map(([, item]) => item.value as T);

  return {
    async saveEnvironment(record) {
      const state = read();
      state[`env#${record.id}`] = { value: record };
      write(state);
    },
    async getEnvironment(id) {
      return (read()[`env#${id}`]?.value as EnvironmentRecord | undefined) ?? null;
    },
    async listEnvironments() {
      return values<EnvironmentRecord>("env#");
    },
    async saveRun(run) {
      const state = read();
      state[`run#${run.environmentId}#${run.id}`] = { value: run };
      write(state);
    },
    async getRun(environmentId, runId) {
      return (read()[`run#${environmentId}#${runId}`]?.value as EnvironmentRun | undefined) ?? null;
    },
    async listRuns(environmentId) {
      return values<EnvironmentRun>(`run#${environmentId}#`);
    },
  };
}
