import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { dynamo } from "../../src/db-client";

describe("given DynamoDB Local is running", () => {
  it("accepts requests from the shared client", async () => {
    const res = await dynamo.send(new ListTablesCommand({}));
    expect(res.TableNames).toBeInstanceOf(Array);
  });
});
