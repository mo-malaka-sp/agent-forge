import fs from "node:fs";
import path from "node:path";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

import { loadSafPocConfig } from "@/lib/saf-poc/config";

export interface StoredDocument<T = unknown> {
  key: string;
  value: T;
  updatedAt: string;
}

export interface SafPocStore {
  get<T>(key: string): Promise<T | null>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list<T>(prefix: string): Promise<Array<StoredDocument<T>>>;
}

const PARTITION = "SAF_POC";
let cachedStore: SafPocStore | null = null;

export function getSafPocStore(): SafPocStore {
  if (cachedStore) {
    return cachedStore;
  }
  const config = loadSafPocConfig();
  cachedStore = config.tableName
    ? createDynamoStore(config.tableName)
    : createFileStore(config.localStatePath);
  return cachedStore;
}

export function resetSafPocStoreForTests(): void {
  cachedStore = null;
}

export function createDynamoStore(
  tableName: string,
  client = DynamoDBDocumentClient.from(new DynamoDBClient({})),
): SafPocStore {
  return {
    async get<T>(key: string) {
      const response = await client.send(
        new GetCommand({ TableName: tableName, Key: { pk: PARTITION, sk: key } }),
      );
      return (response.Item?.value as T | undefined) ?? null;
    },
    async put<T>(key: string, value: T) {
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            pk: PARTITION,
            sk: key,
            value,
            updatedAt: new Date().toISOString(),
          },
        }),
      );
    },
    async delete(key: string) {
      await client.send(
        new DeleteCommand({ TableName: tableName, Key: { pk: PARTITION, sk: key } }),
      );
    },
    async list<T>(prefix: string) {
      const response = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": PARTITION, ":prefix": prefix },
        }),
      );
      return (response.Items ?? []).map((item) => ({
        key: String(item.sk),
        value: item.value as T,
        updatedAt: String(item.updatedAt),
      }));
    },
  };
}

type LocalState = Record<string, StoredDocument>;

export function createFileStore(filePath: string): SafPocStore {
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = chain.then(operation, operation);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const read = (): LocalState => {
    if (!fs.existsSync(filePath)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as LocalState;
  };
  const write = (state: LocalState): void => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(temporary, filePath);
  };

  return {
    get: <T>(key: string) =>
      enqueue(async () => (read()[key]?.value as T | undefined) ?? null),
    put: <T>(key: string, value: T) =>
      enqueue(async () => {
        const state = read();
        state[key] = { key, value, updatedAt: new Date().toISOString() };
        write(state);
      }),
    delete: (key: string) =>
      enqueue(async () => {
        const state = read();
        delete state[key];
        write(state);
      }),
    list: <T>(prefix: string) =>
      enqueue(async () =>
        Object.values(read())
          .filter((entry) => entry.key.startsWith(prefix))
          .sort((left, right) => left.key.localeCompare(right.key))
          .map((entry) => entry as StoredDocument<T>),
      ),
  };
}
