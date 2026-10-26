import { App } from "aws-cdk-lib";
import { CiAccessStack } from "../lib/ci-access-stack";
import { LedgerStack } from "../lib/ledger-stack";

const app = new App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: "ap-southeast-2" };

new LedgerStack(app, "LedgerApi", { env });
// Deployed once by hand; see README.
new CiAccessStack(app, "LedgerApiCiAccess", { env, repo: "kingtigerwin/ledger-api" });
