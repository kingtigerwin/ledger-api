import { App } from "aws-cdk-lib";
import { CiAccessStack } from "../lib/ci-access-stack";
import { LedgerStack } from "../lib/ledger-stack";

const app = new App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: "ap-southeast-2" };

new LedgerStack(app, "LedgerApi", { env });
// Deployed once by hand; see README. The repo uses GitHub's immutable OIDC subject, which
// includes the owner and repo IDs, so the trust still holds if either is renamed.
new CiAccessStack(app, "LedgerApiCiAccess", {
  env,
  githubSubjectPrefix: "repo:kingtigerwin@9473411/ledger-api@1434244010",
});
