import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db-client";

export type Role = "admin" | "customer";
export type UserStatus = "pending" | "active" | "disabled";

export interface User {
  id: string;
  username: string;
  role: Role;
  status: UserStatus;
  createdAt: string;
}

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
    return user;
  },
  };
}
