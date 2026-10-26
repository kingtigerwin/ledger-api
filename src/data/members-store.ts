import { randomUUID } from "node:crypto";
import {
  GetCommand,
  QueryCommand,
  type QueryCommandOutput,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db-client";

export interface Member {
  id: string;
  name: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export class MemberNameTakenError extends Error {}
export class MemberNotFoundError extends Error {}

const userPk = (userId: string) => `USER#${userId}`;
const memberKey = (userId: string, memberId: string) => ({ pk: userPk(userId), sk: `MEMBER#${memberId}` });
const nameKey = (userId: string, name: string) => ({ pk: userPk(userId), sk: `MEMBERNAME#${name.toLowerCase()}` });

const toMember = ({ id, name, archived, createdAt, updatedAt }: Record<string, unknown>) =>
  ({ id, name, archived, createdAt, updatedAt }) as Member;

export function createMembersStore(tableName: string) {
  return {
    async create(userId: string, name: string, now: Date): Promise<Member> {
      const member: Member = { id: randomUUID(), name, archived: false, createdAt: now.toISOString(), updatedAt: now.toISOString() };
      try {
        await ddb.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: tableName,
                  Item: { ...nameKey(userId, name), memberId: member.id },
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              },
              { Put: { TableName: tableName, Item: { ...memberKey(userId, member.id), ...member } } },
            ],
          }),
        );
      } catch (err) {
        if (err instanceof Error && err.name === "TransactionCanceledException") throw new MemberNameTakenError();
        throw err;
      }
      return member;
    },

    async get(userId: string, memberId: string): Promise<Member | undefined> {
      const { Item } = await ddb.send(
        new GetCommand({ TableName: tableName, Key: memberKey(userId, memberId), ConsistentRead: true }),
      );
      return Item ? toMember(Item) : undefined;
    },

    /** Renames a member, moving the household's name claim from the old name to the new one. */
    async rename(userId: string, memberId: string, name: string, now: Date): Promise<Member> {
      const current = await this.get(userId, memberId);
      if (!current) throw new MemberNotFoundError();
      const updateMember = {
        Update: {
          TableName: tableName,
          Key: memberKey(userId, memberId),
          UpdateExpression: "SET #name = :name, updatedAt = :now",
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeNames: { "#name": "name" },
          ExpressionAttributeValues: { ":name": name, ":now": now.toISOString() },
        },
      };
      // Only the letter case changes, so the claim (stored lowercase) stays as it is.
      const sameClaim = current.name.toLowerCase() === name.toLowerCase();
      try {
        await ddb.send(
          new TransactWriteCommand({
            TransactItems: sameClaim
              ? [updateMember]
              : [
                  {
                    Put: {
                      TableName: tableName,
                      Item: { ...nameKey(userId, name), memberId },
                      ConditionExpression: "attribute_not_exists(pk)",
                    },
                  },
                  { Delete: { TableName: tableName, Key: nameKey(userId, current.name) } },
                  updateMember,
                ],
          }),
        );
      } catch (err) {
        if (!(err instanceof Error && err.name === "TransactionCanceledException")) throw err;
        const reasons = (err as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
        if (!sameClaim && reasons[0]?.Code === "ConditionalCheckFailed") throw new MemberNameTakenError();
        throw new MemberNotFoundError();
      }
      return { ...current, name, updatedAt: now.toISOString() };
    },

    /** A household has a handful of members, so this returns them all, sorted by name. */
    async list(userId: string): Promise<Member[]> {
      const members: Member[] = [];
      let startKey: Record<string, unknown> | undefined;
      do {
        const page: QueryCommandOutput = await ddb.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues: { ":pk": userPk(userId), ":prefix": "MEMBER#" },
            ExclusiveStartKey: startKey,
          }),
        );
        members.push(...(page.Items ?? []).map(toMember));
        startKey = page.LastEvaluatedKey;
      } while (startKey);
      return members.sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}
