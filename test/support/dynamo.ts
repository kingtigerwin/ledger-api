import { randomUUID } from "node:crypto";
import { CreateTableCommand, DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import { dynamo } from "../../src/db-client";
import { usersTableKeys } from "../../src/auth/users-table";

/** Creates a uniquely named Users table in DynamoDB Local and returns its name. */
export async function createUsersTable(): Promise<string> {
  const name = `Users-${randomUUID()}`;
  await dynamo.send(
    new CreateTableCommand({
      TableName: name,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: usersTableKeys.partitionKey, AttributeType: "S" },
        { AttributeName: usersTableKeys.sortKey, AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: usersTableKeys.partitionKey, KeyType: "HASH" },
        { AttributeName: usersTableKeys.sortKey, KeyType: "RANGE" },
      ],
    }),
  );
  return name;
}

export async function deleteTable(name: string): Promise<void> {
  await dynamo.send(new DeleteTableCommand({ TableName: name }));
}
