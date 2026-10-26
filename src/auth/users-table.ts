// Key schema for the Users table, shared by the CDK stack and the integration tests.
//
//   pk                      sk          item
//   USER#<userId>           PROFILE     the user: username, password hash, status, role, lockout state
//   USERNAME#<lowercase>    USERNAME    claims a username so two users can't share it
export const usersTableKeys = { partitionKey: "pk", sortKey: "sk" } as const;
