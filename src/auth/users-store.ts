import { randomUUID } from "node:crypto";
import {
  BatchGetCommand,
  type BatchGetCommandOutput,
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
import type { Locale } from "./schemas";

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export type Role = "admin" | "customer";
export type UserStatus = "pending" | "active" | "disabled";

export interface User {
  id: string;
  username: string;
  /** Customers give one when they register; the bootstrap admin and earlier users have none. */
  email?: string;
  role: Role;
  status: UserStatus;
  createdAt: string;
  /** The language the customer chose, or their browser's when they signed up; none means English. */
  locale?: Locale;
}

/** The user from a profile item, without its password hash, lockout or other bookkeeping. */
const toUser = ({ id, username, email, role, status, createdAt, locale }: Record<string, any>): User => // eslint-disable-line @typescript-eslint/no-explicit-any
  ({ id, username, email, role, status, createdAt, locale });

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
const googleKey = (sub: string) => ({ pk: `GOOGLE#${sub}`, sk: "GOOGLE" });
const refreshTokenKey = (userId: string, tokenHash: string) => ({ pk: `USER#${userId}`, sk: `REFRESH#${tokenHash}` });

// `ttl` (epoch seconds) lets DynamoDB delete expired tokens for free.
const refreshTokenItem = (userId: string, tokenHash: string, expiresAt: Date) => ({
  ...refreshTokenKey(userId, tokenHash),
  expiresAt: expiresAt.toISOString(),
  ttl: Math.floor(expiresAt.getTime() / 1000),
});

export function createUsersStore(tableName: string) {
  /**
   * The user's Google claims, if any. Only `sub` finds a claim and the profile doesn't hold it, so this scans,
   * as listing users does; deleting a user is rare.
   */
  const googleKeys = async (userId: string) => {
    const keys: Record<string, unknown>[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const page: ScanCommandOutput = await ddb.send(
        new ScanCommand({
          TableName: tableName,
          FilterExpression: "sk = :google AND userId = :userId",
          ExpressionAttributeValues: { ":google": "GOOGLE", ":userId": userId },
          ProjectionExpression: "pk, sk",
          ConsistentRead: true,
          ExclusiveStartKey: startKey,
        }),
      );
      keys.push(...(page.Items ?? []));
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    return keys;
  };

  return {
    /** Creates the user and claims the username in one transaction, so two users can never share a name. */
    async create(input: {
      username: string;
      email?: string;
      locale?: Locale;
      passwordHash: string;
      role: Role;
      status: UserStatus;
      now: Date;
    }): Promise<User> {
      const user: User = {
        id: randomUUID(),
        username: input.username,
        email: input.email,
        role: input.role,
        status: input.status,
        createdAt: input.now.toISOString(),
        locale: input.locale,
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

    async findByGoogleSub(sub: string): Promise<User | undefined> {
      const { Item: claim } = await ddb.send(
        new GetCommand({ TableName: tableName, Key: googleKey(sub), ConsistentRead: true }),
      );
      return claim ? this.getById(claim.userId as string) : undefined;
    },

    /**
     * An active customer with no password: Google has verified their address, and the agent's daily limits bound
     * what they can cost. They claim the Google account as well as the username, so one Google account can never
     * have two users. If a second sign-in got there first, returns that user. Throws UsernameTakenError if the
     * username belongs to someone else.
     */
    async createGoogleUser(input: {
      sub: string;
      username: string;
      email: string;
      locale?: Locale;
      now: Date;
    }): Promise<User> {
      const user: User = {
        id: randomUUID(),
        username: input.username,
        email: input.email,
        role: "customer",
        status: "active",
        createdAt: input.now.toISOString(),
        locale: input.locale,
      };
      try {
        await ddb.send(
          new TransactWriteCommand({
            TransactItems: [
              ...[usernameKey(user.username), googleKey(input.sub)].map((key) => ({
                Put: {
                  TableName: tableName,
                  Item: { ...key, userId: user.id },
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              })),
              { Put: { TableName: tableName, Item: { ...profileKey(user.id), ...user, authProvider: "google" } } },
            ],
          }),
        );
      } catch (err) {
        if (!(err instanceof Error && err.name === "TransactionCanceledException")) throw err;
        const existing = await this.findByGoogleSub(input.sub);
        if (!existing) throw new UsernameTakenError();
        return existing;
      }
      return user;
    },

    /** `passwordHash` is missing for someone who signs in with Google, and so has no password. */
    async findByUsername(username: string): Promise<
      { user: User; passwordHash?: string; failedLogins: number; lockedUntil?: string } | undefined
    > {
      const { Item: claim } = await ddb.send(
        new GetCommand({ TableName: tableName, Key: usernameKey(username), ConsistentRead: true }),
      );
      if (!claim) return undefined;
      const { Item } = await ddb.send(
        new GetCommand({ TableName: tableName, Key: profileKey(claim.userId as string), ConsistentRead: true }),
      );
      if (!Item) return undefined;
      const { passwordHash, failedLogins = 0, lockedUntil } = Item;
      return {
        user: toUser(Item),
        passwordHash,
        failedLogins,
        lockedUntil,
      };
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
        users.push(...(page.Items ?? []).map(toUser));
        startKey = page.LastEvaluatedKey;
      } while (startKey);
      return users.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async getById(userId: string): Promise<User | undefined> {
      const { Item } = await ddb.send(
        new GetCommand({ TableName: tableName, Key: profileKey(userId), ConsistentRead: true }),
      );
      return Item && toUser(Item);
    },

    /** False for a disabled or deleted user, whose access token may not have expired yet. */
    async isActive(userId: string): Promise<boolean> {
      return (await this.getById(userId))?.status === "active";
    },

    /** The ID of the user who holds `username`, from its claim alone (no profile or password hash read). */
    async userIdFor(username: string): Promise<string | undefined> {
      const { Item } = await ddb.send(new GetCommand({ TableName: tableName, Key: usernameKey(username) }));
      return Item?.userId as string | undefined;
    },

    /** Usernames by user ID; IDs with no profile are left out. BatchGet takes at most 100 keys a call. */
    async usernames(userIds: string[]): Promise<Map<string, string>> {
      const found = new Map<string, string>();
      const unique = [...new Set(userIds)];
      for (let i = 0; i < unique.length; i += 100) {
        let keys: Record<string, unknown>[] | undefined = unique.slice(i, i + 100).map(profileKey);
        while (keys?.length) {
          const res: BatchGetCommandOutput = await ddb.send(
            new BatchGetCommand({
              RequestItems: { [tableName]: { Keys: keys, ProjectionExpression: "id, username" } },
            }),
          );
          for (const item of res.Responses?.[tableName] ?? []) found.set(item.id, item.username);
          keys = res.UnprocessedKeys?.[tableName]?.Keys;
        }
      }
      return found;
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
        return toUser(Attributes!);
      } catch (err) {
        if (err instanceof Error && err.name === "ConditionalCheckFailedException") throw new UserNotFoundError();
        throw err;
      }
    },

    /** Saves the customer's language; `null` removes it. Throws UserNotFoundError rather than create a profile. */
    async setLocale(userId: string, locale: Locale | null): Promise<User> {
      try {
        const { Attributes } = await ddb.send(
          new UpdateCommand({
            TableName: tableName,
            Key: profileKey(userId),
            ConditionExpression: "attribute_exists(pk)",
            ExpressionAttributeNames: { "#locale": "locale" },
            ...(locale
              ? { UpdateExpression: "SET #locale = :locale", ExpressionAttributeValues: { ":locale": locale } }
              : { UpdateExpression: "REMOVE #locale" }),
            ReturnValues: "ALL_NEW",
          }),
        );
        return toUser(Attributes!);
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

    /**
     * Deletes the user and every item of theirs, which frees their username and Google account. The profile and
     * claims go together, so a Google claim can never outlive its profile: findByGoogleSub would find nobody,
     * and createGoogleUser would be refused, shutting that person out for good.
     */
    async delete(user: User): Promise<void> {
      await this.revokeRefreshTokens(user.id);
      const keys = [profileKey(user.id), usernameKey(user.username), ...(await googleKeys(user.id))];
      await ddb.send(
        new TransactWriteCommand({ TransactItems: keys.map((Key) => ({ Delete: { TableName: tableName, Key } })) }),
      );
    },

    /** Deletes every refresh token the user has, logging them out everywhere. */
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
