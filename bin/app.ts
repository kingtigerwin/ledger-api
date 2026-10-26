import { App } from "aws-cdk-lib";
import { LedgerStack } from "../lib/ledger-stack";

const app = new App();

new LedgerStack(app, "LedgerApi", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: "ap-southeast-2" },
});
