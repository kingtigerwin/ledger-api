import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import {
  DescribeStreamCommand,
  DynamoDBStreamsClient,
  GetRecordsCommand,
  GetShardIteratorCommand,
} from "@aws-sdk/client-dynamodb-streams";
import type { DynamoDBRecord } from "aws-lambda";
import { dynamo } from "../../src/db-client";

const streams = new DynamoDBStreamsClient(
  process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {},
);

/** Every record on the table's stream so far, oldest first, in the shape Lambda receives them. */
export async function streamRecords(tableName: string): Promise<DynamoDBRecord[]> {
  const { Table } = await dynamo.send(new DescribeTableCommand({ TableName: tableName }));
  const StreamArn = Table!.LatestStreamArn!;
  const { StreamDescription } = await streams.send(new DescribeStreamCommand({ StreamArn }));
  const records: DynamoDBRecord[] = [];
  for (const { ShardId } of StreamDescription?.Shards ?? []) {
    let { ShardIterator } = await streams.send(
      new GetShardIteratorCommand({ StreamArn, ShardId, ShardIteratorType: "TRIM_HORIZON" }),
    );
    while (ShardIterator) {
      const page = await streams.send(new GetRecordsCommand({ ShardIterator }));
      records.push(...((page.Records ?? []) as DynamoDBRecord[]));
      // An open shard always hands back a next iterator; stop once it has nothing more.
      ShardIterator = page.Records?.length ? page.NextShardIterator : undefined;
    }
  }
  return records;
}
