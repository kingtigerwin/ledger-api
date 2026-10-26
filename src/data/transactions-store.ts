import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db-client";
import type { CreateTransactionInput, Transaction } from "./transaction-schema";

/** The ID was already used: the request is a retry (or a client bug), not a new transaction. */
export class TransactionExistsError extends Error {}

const userPk = (userId: string) => `USER#${userId}`;
const sortKey = (date: string, id: string) => `${date}#${id}`;

// The transaction sorts by date; this pointer finds it by ID alone.
const refKey = (userId: string, id: string) => ({ pk: userPk(userId), sk: `TXNREF#${id}` });
const mainKey = (userId: string, date: string, id: string) => ({ pk: userPk(userId), sk: `TXN#${sortKey(date, id)}` });

/** The stored item: the transaction plus its keys in the table and both indexes. */
const toItem = (userId: string, t: Transaction) => ({
  ...mainKey(userId, t.date, t.id),
  gsi1pk: `${userPk(userId)}#MEMBER#${t.memberId}`,
  gsi1sk: sortKey(t.date, t.id),
  gsi2pk: `${userPk(userId)}#CATEGORY#${t.category}`,
  gsi2sk: sortKey(t.date, t.id),
  ...t,
});

const fromItem = (item: Record<string, unknown>): Transaction => {
  const { id, memberId, date, merchant, category, item: what, amountCents, currency, note, version, createdAt, updatedAt } =
    item as unknown as Transaction;
  return { id, memberId, date, merchant, category, item: what, amountCents, currency, note, version, createdAt, updatedAt };
};

export function createTransactionsStore(tableName: string) {
  return {
    async create(userId: string, input: CreateTransactionInput, now: Date): Promise<Transaction> {
      const transaction: Transaction = { ...input, version: 1, createdAt: now.toISOString(), updatedAt: now.toISOString() };
      try {
        await ddb.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: tableName,
                  Item: { ...refKey(userId, input.id), date: input.date },
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              },
              { Put: { TableName: tableName, Item: toItem(userId, transaction) } },
            ],
          }),
        );
      } catch (err) {
        if (err instanceof Error && err.name === "TransactionCanceledException") throw new TransactionExistsError();
        throw err;
      }
      return transaction;
    },

    async get(userId: string, id: string): Promise<Transaction | undefined> {
      const { Item: ref } = await ddb.send(
        new GetCommand({ TableName: tableName, Key: refKey(userId, id), ConsistentRead: true }),
      );
      if (!ref) return undefined;
      const { Item } = await ddb.send(
        new GetCommand({ TableName: tableName, Key: mainKey(userId, ref.date as string, id), ConsistentRead: true }),
      );
      return Item ? fromItem(Item) : undefined;
    },
  };
}
