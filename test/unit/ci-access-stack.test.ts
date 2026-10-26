import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { CiAccessStack } from "../../lib/ci-access-stack";

describe("CiAccessStack", () => {
  let template: Template;

  beforeAll(() => {
    const stack = new CiAccessStack(new App(), "LedgerApiCiAccess", {
      env: { account: "123456789012", region: "ap-southeast-2" },
      repo: "kingtigerwin/ledger-api",
    });
    template = Template.fromStack(stack);
  });

  it("trusts GitHub's OIDC tokens", () => {
    template.hasResourceProperties("AWS::IAM::OIDCProvider", {
      Url: "https://token.actions.githubusercontent.com",
      ClientIdList: ["sts.amazonaws.com"],
    });
  });

  it("lets only this repo's main branch assume the deploy role", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              StringEquals: {
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                "token.actions.githubusercontent.com:sub": "repo:kingtigerwin/ledger-api:ref:refs/heads/main",
              },
            },
          }),
        ],
      },
    });
  });

  it("can only assume CDK's bootstrap roles and read the admin password", () => {
    const statements = Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
      (p) => p.Properties.PolicyDocument.Statement,
    );

    expect(statements.map((s) => s.Action).sort()).toEqual(["ssm:GetParameter", "sts:AssumeRole"]);
    const assume = statements.find((s) => s.Action === "sts:AssumeRole");
    expect(JSON.stringify(assume.Resource)).toContain(":role/cdk-hnb659fds-*");
    const ssm = statements.find((s) => s.Action === "ssm:GetParameter");
    expect(JSON.stringify(ssm.Resource)).toContain("parameter/ledger-api/admin-password");
  });

  it("outputs the role ARN for the GitHub workflow", () => {
    template.hasOutput("DeployRoleArn", {});
  });
});
