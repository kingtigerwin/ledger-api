import { randomUUID } from "node:crypto";
import { QueryCommand, type QueryCommandOutput, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db-client";

export interface Member {
  id: string;
  name: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export class MemberNameTakenError extends Error {}

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
