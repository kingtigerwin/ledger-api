import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db-client";
import type { CreateTransactionInput, ListQuery, Transaction, TransactionFields } from "./transaction-schema";

/** The ID was already used: the request is a retry (or a client bug), not a new transaction. */
export class TransactionExistsError extends Error {}

export class TransactionNotFoundError extends Error {}
/** Someone else changed the transaction since the client read it. */
export class VersionConflictError extends Error {}

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

// Sort keys are `<date>#<id>`, so a date range is a key range: from the start of `from`
// to the end of `to` (the high character sorts after any ID).
const EARLIEST = "0000-01-01";
const LATEST = "9999-12-31";
const rangeEnd = (date: string) => `${date}#\uffff`;

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

    /**
     * Applies an edit if `expectedVersion` is still current. A new date changes the sort key,
     * so the item is moved: old item deleted, new one written and the pointer updated, atomically.
     */
    async update(
      userId: string,
      id: string,
      expectedVersion: number,
      changes: Partial<TransactionFields>,
      now: Date,
    ): Promise<Transaction> {
      const current = await this.get(userId, id);
      if (!current) throw new TransactionNotFoundError();
      if (current.version !== expectedVersion) throw new VersionConflictError();
      const next: Transaction = { ...current, ...changes, version: current.version + 1, updatedAt: now.toISOString() };
      const versionCheck = {
        ConditionExpression: "version = :expected",
        ExpressionAttributeValues: { ":expected": expectedVersion },
      };
      const putNext = { Put: { TableName: tableName, Item: toItem(userId, next) } };
      try {
        await ddb.send(
          new TransactWriteCommand({
            TransactItems:
              next.date === current.date
                ? [{ Put: { ...putNext.Put, ...versionCheck } }]
                : [
                    { Delete: { TableName: tableName, Key: mainKey(userId, current.date, id), ...versionCheck } },
                    putNext,
                    {
                      Update: {
                        TableName: tableName,
                        Key: refKey(userId, id),
                        UpdateExpression: "SET #date = :date",
                        ExpressionAttributeNames: { "#date": "date" },
                        ExpressionAttributeValues: { ":date": next.date },
                      },
                    },
                  ],
          }),
        );
      } catch (err) {
        if (err instanceof Error && err.name === "TransactionCanceledException") throw new VersionConflictError();
        throw err;
      }
      return next;
    },

    async delete(userId: string, id: string): Promise<void> {
      const current = await this.get(userId, id);
      if (!current) throw new TransactionNotFoundError();
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            { Delete: { TableName: tableName, Key: mainKey(userId, current.date, id) } },
            { Delete: { TableName: tableName, Key: refKey(userId, id) } },
          ],
        }),
      );
    },

    /**
     * Newest first. Picks the access path the filters allow: the by-member index (with category
     * as a filter if given), the by-category index, or the main key. Dates are always a key range.
     */
    async list(
      userId: string,
      query: Omit<ListQuery, "cursor" | "limit"> & { limit: number },
      startKey?: Record<string, unknown>,
    ): Promise<{ items: Transaction[]; lastKey?: Record<string, unknown> }> {
      const from = query.from ?? EARLIEST;
      const to = rangeEnd(query.to ?? LATEST);
      const path = query.memberId
        ? { IndexName: "byMember", pk: "gsi1pk", pkValue: `${userPk(userId)}#MEMBER#${query.memberId}`, sk: "gsi1sk", prefix: "" }
        : query.category
          ? { IndexName: "byCategory", pk: "gsi2pk", pkValue: `${userPk(userId)}#CATEGORY#${query.category}`, sk: "gsi2sk", prefix: "" }
          : { IndexName: undefined, pk: "pk", pkValue: userPk(userId), sk: "sk", prefix: "TXN#" };
      const filterByCategory = Boolean(query.memberId && query.category);
      const res = await ddb.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: path.IndexName,
          KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :from AND :to",
          FilterExpression: filterByCategory ? "category = :category" : undefined,
          ExpressionAttributeNames: { "#pk": path.pk, "#sk": path.sk },
          ExpressionAttributeValues: {
            ":pk": path.pkValue,
            ":from": path.prefix + from,
            ":to": path.prefix + to,
            ...(filterByCategory ? { ":category": query.category } : {}),
          },
          ScanIndexForward: false,
          Limit: query.limit,
          ExclusiveStartKey: startKey,
        }),
      );
      return { items: (res.Items ?? []).map(fromItem), lastKey: res.LastEvaluatedKey };
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
