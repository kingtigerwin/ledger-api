import { App, Stack } from "aws-cdk-lib";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { LedgerStack, type LedgerStackProps } from "../../lib/ledger-stack";

const domain = { domainName: "api.example.cloud", zoneName: "example.cloud", hostedZoneId: "ZEXAMPLE123" };
const env = { account: "111111111111", region: "ap-southeast-2" };
const CERTIFICATE_ARN = "arn:aws:acm:us-east-1:111111111111:certificate/abc";

const synth = (props: Partial<LedgerStackProps>) =>
  Template.fromStack(new LedgerStack(new App(), "LedgerApi", { env, ...props }));
/** The custom domain, with an imported certificate: only its ARN matters here. */
const customDomain = (app: App) => ({
  ...domain,
  certificate: Certificate.fromCertificateArn(new Stack(app, "Scratch", { env }), "Cert", CERTIFICATE_ARN),
});

describe("given an email sender in the custom domain", () => {
  let template: Template;

  beforeAll(() => {
    const app = new App();
    template = Template.fromStack(
      new LedgerStack(app, "LedgerApi", { env, customDomain: customDomain(app), emailFrom: "noreply@example.cloud" }),
    );
  });

  it("verifies the domain with SES, adding its DKIM records to the existing zone", () => {
    // DKIM signing is SES's default, so it is left unset rather than turned off.
    template.hasResourceProperties("AWS::SES::EmailIdentity", {
      EmailIdentity: "example.cloud",
      DkimAttributes: Match.absent(),
    });
    const dkim = Object.values(template.findResources("AWS::Route53::RecordSet")).filter(
      (r) => r.Properties.Type === "CNAME",
    );
    expect(dkim).toHaveLength(3);
    for (const record of dkim) expect(record.Properties.HostedZoneId).toBe("ZEXAMPLE123");
  });

  it("streams the Users table with old and new images", () => {
    template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      KeySchema: Match.anyValue(),
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
      StreamSpecification: { StreamViewType: "NEW_AND_OLD_IMAGES" },
    });
  });

  it("sends from the notify function, which only hears about profile items", () => {
    const [, notify] = Object.entries(template.findResources("AWS::Lambda::Function")).find(([id]) =>
      id.startsWith("NotifyFunction"),
    )!;
    expect(notify.Properties.Environment.Variables).toEqual({ EMAIL_FROM: "noreply@example.cloud" });
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      FunctionName: Match.anyValue(),
      StartingPosition: "LATEST",
      FilterCriteria: { Filters: [{ Pattern: JSON.stringify({ dynamodb: { Keys: { sk: { S: ["PROFILE"] } } } }) }] },
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      MaximumRetryAttempts: 3,
      BisectBatchOnFunctionError: true,
      DestinationConfig: { OnFailure: { Destination: Match.anyValue() } },
    });
  });

  it("lets the notify function send email from the domain and do nothing else with SES", () => {
    const [, policy] = Object.entries(template.findResources("AWS::IAM::Policy")).find(([id]) =>
      id.startsWith("NotifyFunctionServiceRoleDefaultPolicy"),
    )!;
    const actions = policy.Properties.PolicyDocument.Statement.flatMap((s: { Action: string | string[] }) =>
      [s.Action].flat(),
    );
    expect(actions.filter((a: string) => a.startsWith("ses:"))).toEqual(["ses:SendEmail", "ses:SendRawEmail"]);
    const send = policy.Properties.PolicyDocument.Statement.find((s: { Action: string | string[] }) =>
      [s.Action].flat().includes("ses:SendEmail"),
    );
    const [identityId] = Object.keys(template.findResources("AWS::SES::EmailIdentity"));
    expect(JSON.stringify(send.Resource)).toContain(":identity/");
    expect(JSON.stringify(send.Resource)).toContain(JSON.stringify({ Ref: identityId }));
  });

  it("keeps emails that still fail after retries in a queue, with an alarm", () => {
    template.resourceCountIs("AWS::SQS::Queue", 1);
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "AWS/SQS",
      MetricName: "ApproximateNumberOfMessagesVisible",
      Threshold: 1,
      AlarmActions: [Match.anyValue()],
    });
    // Five alarms: still within CloudWatch's free 10.
    template.resourceCountIs("AWS::CloudWatch::Alarm", 5);
  });
});

describe("given no email sender", () => {
  it("sends no email: no SES identity, notify function, stream or queue", () => {
    const template = synth({});

    template.resourceCountIs("AWS::SES::EmailIdentity", 0);
    template.resourceCountIs("AWS::Lambda::EventSourceMapping", 0);
    template.resourceCountIs("AWS::SQS::Queue", 0);
    const [users] = Object.values(template.findResources("AWS::DynamoDB::GlobalTable")).filter(
      (t) => t.Properties.TimeToLiveSpecification,
    );
    expect(users?.Properties.StreamSpecification).toBeUndefined();
  });
});

describe("given an email sender outside the custom domain", () => {
  it("refuses to synthesize, since SES can only be verified through the domain's zone", () => {
    const app = new App();

    expect(
      () => new LedgerStack(app, "LedgerApi", { env, customDomain: customDomain(app), emailFrom: "noreply@elsewhere.com" }),
    ).toThrow(/example\.cloud/);
  });

  it("refuses an email sender without a custom domain", () => {
    expect(() => synth({ emailFrom: "noreply@example.cloud" })).toThrow(/customDomain/);
  });
});
