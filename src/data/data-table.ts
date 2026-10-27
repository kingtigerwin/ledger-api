// Key schema for the Data table, shared by the CDK stack and the integration tests.
// Everything a customer owns lives under their partition, so a query can never cross customers.
//
//   pk              sk                   item
//   USER#<userId>   TXN#<date>#<txnId>   a transaction
//   USER#<userId>   TXNREF#<txnId>       points at the transaction's date, so it can be found by ID
//
// Indexes, both sorted by `<date>#<txnId>`:
//   byCategory (gsi2pk = USER#<userId>#CATEGORY#<category>): one customer's transactions in a category.
//     It keeps the gsi2 names it had when a by-member index (gsi1) existed: renaming would replace the index.
//   allByDate (gsi3pk = TXN): every customer's transactions, for the admin. One partition is plenty
//     at household scale; it would need sharding by month if writes ever got near 1,000/second.
export const dataTableKeys = {
  partitionKey: "pk",
  sortKey: "sk",
  indexes: [
    { name: "byCategory", partitionKey: "gsi2pk", sortKey: "gsi2sk" },
    { name: "allByDate", partitionKey: "gsi3pk", sortKey: "gsi3sk" },
  ],
} as const;
