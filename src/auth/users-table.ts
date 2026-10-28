// Key schema for the Users table, shared by the CDK stack and the integration tests.
//
//   pk                      sk          item
//   USER#<userId>           PROFILE     the user: username, email, password hash, status, role, lockout state
//   USERNAME#<lowercase>    USERNAME    claims a username so two users can't share it
//
// When emails are on, the table streams old and new images to the notify Lambda.
export const usersTableKeys = { partitionKey: "pk", sortKey: "sk", streamViewType: "NEW_AND_OLD_IMAGES" } as const;
