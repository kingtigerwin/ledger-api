import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
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

export class InvalidRefreshTokenError extends Error {}

const profileKey = (id: string) => ({ pk: `USER#${id}`, sk: "PROFILE" });
const usernameKey = (username: string) => ({ pk: `USERNAME#${username}`, sk: "USERNAME" });
const refreshTokenKey = (userId: string, tokenHash: string) => ({ pk: `USER#${userId}`, sk: `REFRESH#${tokenHash}` });

// `ttl` (epoch seconds) lets DynamoDB delete expired tokens for free.
const refreshTokenItem = (userId: string, tokenHash: string, expiresAt: Date) => ({
  ...refreshTokenKey(userId, tokenHash),
  expiresAt: expiresAt.toISOString(),
  ttl: Math.floor(expiresAt.getTime() / 1000),
});

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

    async getById(userId: string): Promise<User | undefined> {
      const { Item } = await ddb.send(
        new GetCommand({ TableName: tableName, Key: profileKey(userId), ConsistentRead: true }),
      );
      if (!Item) return undefined;
      const { id, username, role, status, createdAt } = Item;
      return { id, username, role, status, createdAt };
    },

    async saveRefreshToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
      await ddb.send(new PutCommand({ TableName: tableName, Item: refreshTokenItem(userId, tokenHash, expiresAt) }));
    },

    /** Marks the old token as replaced and stores the new one; fails if the old token is unknown or already replaced. */
    async rotateRefreshToken(userId: string, oldHash: string, newHash: string, now: Date, expiresAt: Date): Promise<void> {
      try {
        await ddb.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: tableName,
                  Key: refreshTokenKey(userId, oldHash),
                  UpdateExpression: "SET replacedAt = :now",
                  ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(replacedAt)",
                  ExpressionAttributeValues: { ":now": now.toISOString() },
                },
              },
              { Put: { TableName: tableName, Item: refreshTokenItem(userId, newHash, expiresAt) } },
            ],
          }),
        );
      } catch (err) {
        if (err instanceof Error && err.name === "TransactionCanceledException") throw new InvalidRefreshTokenError();
        throw err;
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
