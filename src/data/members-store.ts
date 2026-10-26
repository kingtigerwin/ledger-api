import { randomUUID } from "node:crypto";
import { PutCommand, QueryCommand, type QueryCommandOutput } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db-client";

export interface Member {
  id: string;
  name: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

const userPk = (userId: string) => `USER#${userId}`;
const memberKey = (userId: string, memberId: string) => ({ pk: userPk(userId), sk: `MEMBER#${memberId}` });

const toMember = ({ id, name, archived, createdAt, updatedAt }: Record<string, unknown>) =>
  ({ id, name, archived, createdAt, updatedAt }) as Member;

export function createMembersStore(tableName: string) {
  return {
    async create(userId: string, name: string, now: Date): Promise<Member> {
      const member: Member = { id: randomUUID(), name, archived: false, createdAt: now.toISOString(), updatedAt: now.toISOString() };
      await ddb.send(new PutCommand({ TableName: tableName, Item: { ...memberKey(userId, member.id), ...member } }));
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
