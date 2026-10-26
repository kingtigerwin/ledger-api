import { randomUUID } from "node:crypto";
import { CreateTableCommand, DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import { dynamo } from "../../src/db-client";
import { usersTableKeys } from "../../src/auth/users-table";
import { dataTableKeys } from "../../src/data/data-table";

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

/** Creates a uniquely named Data table, with its indexes, in DynamoDB Local and returns its name. */
export async function createDataTable(): Promise<string> {
  const name = `Data-${randomUUID()}`;
  const { partitionKey, sortKey, indexes } = dataTableKeys;
  const attributes = [partitionKey, sortKey, ...indexes.flatMap((i) => [i.partitionKey, i.sortKey])];
  await dynamo.send(
    new CreateTableCommand({
      TableName: name,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: attributes.map((AttributeName) => ({ AttributeName, AttributeType: "S" })),
      KeySchema: [
        { AttributeName: partitionKey, KeyType: "HASH" },
        { AttributeName: sortKey, KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: indexes.map((i) => ({
        IndexName: i.name,
        KeySchema: [
          { AttributeName: i.partitionKey, KeyType: "HASH" },
          { AttributeName: i.sortKey, KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      })),
    }),
  );
  return name;
}

export async function deleteTable(name: string): Promise<void> {
  await dynamo.send(new DeleteTableCommand({ TableName: name }));
}
