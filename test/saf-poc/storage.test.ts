import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDynamoStore } from "@/lib/saf-poc/storage";

type Item = { pk: string; sk: string; value: unknown; updatedAt: string };

describe("DynamoDB SAF store", () => {
  it("puts, gets, lists by prefix, and deletes", async () => {
    const items = new Map<string, Item>();
    const client = {
      async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
        const input = command.input;
        if (command.constructor.name === "PutCommand") {
          const item = input.Item as Item;
          items.set(item.sk, item);
          return {};
        }
        if (command.constructor.name === "GetCommand") {
          const key = input.Key as { sk: string };
          const item = items.get(key.sk);
          return { Item: item };
        }
        if (command.constructor.name === "DeleteCommand") {
          const key = input.Key as { sk: string };
          items.delete(key.sk);
          return {};
        }
        if (command.constructor.name === "QueryCommand") {
          const prefix = (input.ExpressionAttributeValues as { ":prefix": string })[":prefix"];
          return {
            Items: [...items.values()].filter((item) => item.sk.startsWith(prefix)),
          };
        }
        throw new Error(`Unexpected command ${command.constructor.name}`);
      },
    };

    const store = createDynamoStore("agentforge-saf-poc", client as never);
    await store.put("EVENT#1", { id: "1" });
    await store.put("SSF#state", { kid: "key" });
    assert.deepEqual(await store.get("EVENT#1"), { id: "1" });
    assert.equal((await store.list("EVENT#")).length, 1);
    await store.delete("EVENT#1");
    assert.equal(await store.get("EVENT#1"), null);
    assert.deepEqual(await store.get("SSF#state"), { kid: "key" });
  });
});
