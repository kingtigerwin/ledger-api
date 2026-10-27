// Key schema for the Data table, shared by the CDK stack and the integration tests.
// Everything a customer owns lives under their partition, so a query can never cross customers.
//
//   pk              sk                   item
//   USER#<userId>   TXN#<date>#<txnId>   a transaction
//   USER#<userId>   TXNREF#<txnId>       points at the transaction's date, so it can be found by ID
//
// Index: byCategory (gsi2pk = USER#<userId>#CATEGORY#<category>), sorted by `<date>#<txnId>`.
// It keeps the gsi2 names it had when a by-member index (gsi1) existed: renaming would replace the index.
export const dataTableKeys = {
  partitionKey: "pk",
  sortKey: "sk",
  indexes: [{ name: "byCategory", partitionKey: "gsi2pk", sortKey: "gsi2sk" }],
} as const;
