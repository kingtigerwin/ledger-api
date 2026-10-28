import { App } from "aws-cdk-lib";
import { CertificateStack, type CustomDomain } from "../lib/certificate-stack";
import { CiAccessStack } from "../lib/ci-access-stack";
import { LedgerStack } from "../lib/ledger-stack";

const app = new App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: "ap-southeast-2" };

// Optional: serve the API on a name in an existing Route 53 zone (see cdk.json). The certificate
// must come from us-east-1 for CloudFront, hence the second stack and cross-region references.
const customDomain: CustomDomain | undefined = app.node.tryGetContext("customDomain") || undefined;
if (customDomain) {
  const { certificate } = new CertificateStack(app, "LedgerApiCertificate", {
    env: { ...env, region: "us-east-1" },
    crossRegionReferences: true,
    domain: customDomain,
  });
  new LedgerStack(app, "LedgerApi", {
    env,
    crossRegionReferences: true,
    customDomain: { ...customDomain, certificate },
    // Optional: email customers from this address in the domain's zone (see cdk.json).
    emailFrom: app.node.tryGetContext("emailFrom") || undefined,
    // A personal address, so it comes from a GitHub variable at deploy time, not cdk.json.
    adminEmail: app.node.tryGetContext("adminEmail") || undefined,
    // Optional: ledger-ui's admin page, for the admin's approve or reject link (see cdk.json).
    adminPageUrl: app.node.tryGetContext("adminPageUrl") || undefined,
  });
} else {
  new LedgerStack(app, "LedgerApi", { env });
}
// Deployed once by hand; see README. The repo uses GitHub's immutable OIDC subject, which
// includes the owner and repo IDs, so the trust still holds if either is renamed.
new CiAccessStack(app, "LedgerApiCiAccess", {
  env,
  githubSubjectPrefix: "repo:kingtigerwin@9473411/ledger-api@1434244010",
});
