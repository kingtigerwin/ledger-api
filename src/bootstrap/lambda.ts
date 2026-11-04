import type { CloudFormationCustomResourceEvent } from "aws-lambda";
import { bootstrap } from "./bootstrap";
import { ssmParameterStore } from "./parameters";

// A CDK custom resource: runs on stack create and update. Delete does nothing, so secrets
// and the admin survive a resource replacement.
export const handler = async (event: CloudFormationCustomResourceEvent) => {
  if (event.RequestType !== "Delete") {
    await bootstrap({ tableName: process.env.USERS_TABLE!, parameters: ssmParameterStore() });
  }
  return { PhysicalResourceId: "ledger-api-bootstrap" };
};
