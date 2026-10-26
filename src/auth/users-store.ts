import { randomUUID } from "node:crypto";
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db-client";

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export type Role = "admin" | "customer";
export type UserStatus = "pending" | "active" | "disabled";

export interface User {
  id: string;
  username: string;
  role: Role;
  status: UserStatus;
  createdAt: string;
}

export class UsernameTakenError extends Error {}

const profileKey = (id: string) => ({ pk: `USER#${id}`, sk: "PROFILE" });
const usernameKey = (username: string) => ({ pk: `USERNAME#${username}`, sk: "USERNAME" });

export function createUsersStore(tableName: string) {
  return {
    /** Creates the user and claims the username in one transaction, so two users can never share a name. */
    async create(input: { username: string; passwordHash: string; role: Role; status: UserStatus; now: Date }): Promise<User> {
      const user: User = {
        id: randomUUID(),
        username: input.username,
        role: input.role,
        status: input.status,
        createdAt: input.now.toISOString(),
      };
      try {
        await ddb.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: tableName,
                  Item: { ...usernameKey(user.username), userId: user.id },
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              },
              {
                Put: {
                  TableName: tableName,
                  Item: { ...profileKey(user.id), ...user, passwordHash: input.passwordHash },
                },
              },
            ],
          }),
        );
      } catch (err) {
        if (err instanceof Error && err.name === "TransactionCanceledException") throw new UsernameTakenError();
        throw err;
      }
      return user;
    },

    async findByUsername(username: string): Promise<
      { user: User; passwordHash: string; failedLogins: number; lockedUntil?: string } | undefined
    > {
      const { Item: claim } = await ddb.send(
        new GetCommand({ TableName: tableName, Key: usernameKey(username), ConsistentRead: true }),
      );
      if (!claim) return undefined;
      const { Item } = await ddb.send(
        new GetCommand({ TableName: tableName, Key: profileKey(claim.userId as string), ConsistentRead: true }),
      );
      if (!Item) return undefined;
      const { id, role, status, createdAt, passwordHash, failedLogins = 0, lockedUntil } = Item;
      return { user: { id, username: Item.username, role, status, createdAt }, passwordHash, failedLogins, lockedUntil };
    },

    /** Counts a failed login; the fifth in a row locks the user for 15 minutes and starts the count again. */
    async recordFailedLogin(userId: string, now: Date): Promise<void> {
      const { Attributes } = await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: profileKey(userId),
          UpdateExpression: "ADD failedLogins :one",
          ExpressionAttributeValues: { ":one": 1 },
          ReturnValues: "UPDATED_NEW",
        }),
      );
      if ((Attributes?.failedLogins ?? 0) >= MAX_FAILED_LOGINS) {
        await ddb.send(
          new UpdateCommand({
            TableName: tableName,
            Key: profileKey(userId),
            UpdateExpression: "SET failedLogins = :zero, lockedUntil = :until",
            ExpressionAttributeValues: {
              ":zero": 0,
              ":until": new Date(now.getTime() + LOCKOUT_MS).toISOString(),
            },
          }),
        );
      }
    },

    async clearFailedLogins(userId: string): Promise<void> {
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: profileKey(userId),
          UpdateExpression: "SET failedLogins = :zero REMOVE lockedUntil",
          ExpressionAttributeValues: { ":zero": 0 },
        }),
      );
    },
  };
}
