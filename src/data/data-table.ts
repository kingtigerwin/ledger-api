// Key schema for the Data table, shared by the CDK stack and the integration tests.
// Everything a customer owns lives under their partition, so a query can never cross households.
//
//   pk              sk                         item
//   USER#<userId>   MEMBER#<memberId>          a household member
//   USER#<userId>   MEMBERNAME#<lowercase>     claims a member name so it's unique in the household
//   USER#<userId>   TXN#<date>#<txnId>         a transaction (Stage 5)
//
// Indexes (Stage 5): byMember (gsi1pk = USER#<userId>#MEMBER#<memberId>) and
// byCategory (gsi2pk = USER#<userId>#CATEGORY#<category>), both sorted by `<date>#<txnId>`.
export const dataTableKeys = {
  partitionKey: "pk",
  sortKey: "sk",
  indexes: [
    { name: "byMember", partitionKey: "gsi1pk", sortKey: "gsi1sk" },
    { name: "byCategory", partitionKey: "gsi2pk", sortKey: "gsi2sk" },
  ],
} as const;
