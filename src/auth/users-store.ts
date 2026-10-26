import { randomUUID } from "node:crypto";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandOutput,
  ScanCommand,
  type ScanCommandOutput,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
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
export class UserNotFoundError extends Error {}

export class InvalidRefreshTokenError extends Error {
  /** True when the token existed but had already been replaced: a sign it was copied. */
  constructor(readonly reused: boolean) {
    super(reused ? "Refresh token reused" : "Unknown refresh token");
  }
}

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

    /**
     * Scans the whole table. Fine at household-app scale (an admin listing a few sign-ups);
     * a status index would be the upgrade if the table grows large.
     */
    async listByStatus(status: UserStatus): Promise<User[]> {
      const users: User[] = [];
      let startKey: Record<string, unknown> | undefined;
      do {
        const page: ScanCommandOutput = await ddb.send(
          new ScanCommand({
            TableName: tableName,
            FilterExpression: "sk = :profile AND #status = :status",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":profile": "PROFILE", ":status": status },
            ExclusiveStartKey: startKey,
          }),
        );
        for (const { id, username, role, status, createdAt } of page.Items ?? []) {
          users.push({ id, username, role, status, createdAt });
        }
        startKey = page.LastEvaluatedKey;
      } while (startKey);
      return users.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async getById(userId: string): Promise<User | undefined> {
      const { Item } = await ddb.send(
        new GetCommand({ TableName: tableName, Key: profileKey(userId), ConsistentRead: true }),
      );
      if (!Item) return undefined;
      const { id, username, role, status, createdAt } = Item;
      return { id, username, role, status, createdAt };
    },

    async setStatus(userId: string, status: UserStatus): Promise<User> {
      try {
        const { Attributes } = await ddb.send(
          new UpdateCommand({
            TableName: tableName,
            Key: profileKey(userId),
            UpdateExpression: "SET #status = :status",
            ConditionExpression: "attribute_exists(pk)",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":status": status },
            ReturnValues: "ALL_NEW",
          }),
        );
        const { id, username, role, createdAt } = Attributes!;
        return { id, username, role, status, createdAt };
      } catch (err) {
        if (err instanceof Error && err.name === "ConditionalCheckFailedException") throw new UserNotFoundError();
        throw err;
      }
    },

    async saveRefreshToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
      await ddb.send(new PutCommand({ TableName: tableName, Item: refreshTokenItem(userId, tokenHash, expiresAt) }));
    },

    /** Marks the old token as replaced and stores the new one; fails if the old token is unknown, expired or already replaced. */
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
                  ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(replacedAt) AND expiresAt > :now",
                  ExpressionAttributeValues: { ":now": now.toISOString() },
                },
              },
              { Put: { TableName: tableName, Item: refreshTokenItem(userId, newHash, expiresAt) } },
            ],
          }),
        );
      } catch (err) {
        if (!(err instanceof Error && err.name === "TransactionCanceledException")) throw err;
        const { Item } = await ddb.send(
          new GetCommand({ TableName: tableName, Key: refreshTokenKey(userId, oldHash), ConsistentRead: true }),
        );
        throw new InvalidRefreshTokenError(Boolean(Item?.replacedAt));
      }
    },

    async deleteRefreshToken(userId: string, tokenHash: string): Promise<void> {
      await ddb.send(new DeleteCommand({ TableName: tableName, Key: refreshTokenKey(userId, tokenHash) }));
    },

    /** Deletes every refresh token the user has, logging them out everywhere within one access-token lifetime. */
    async revokeRefreshTokens(userId: string): Promise<void> {
      let startKey: Record<string, unknown> | undefined;
      do {
        const page: QueryCommandOutput = await ddb.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues: { ":pk": `USER#${userId}`, ":prefix": "REFRESH#" },
            ProjectionExpression: "pk, sk",
            ExclusiveStartKey: startKey,
          }),
        );
        await Promise.all(
          (page.Items ?? []).map((key) => ddb.send(new DeleteCommand({ TableName: tableName, Key: key }))),
        );
        startKey = page.LastEvaluatedKey;
      } while (startKey);
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
