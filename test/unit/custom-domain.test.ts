import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { CertificateStack } from "../../lib/certificate-stack";
import { LedgerStack } from "../../lib/ledger-stack";

// A placeholder account: cross-region references need both stacks to name one.
const account = "111111111111";
const domain = { domainName: "api.example.cloud", zoneName: "example.cloud", hostedZoneId: "ZEXAMPLE123" };

describe("given a custom domain", () => {
  let certificate: Template;
  let ledger: Template;

  beforeAll(() => {
    const app = new App();
    const certStack = new CertificateStack(app, "LedgerApiCertificate", {
      env: { account, region: "us-east-1" },
      crossRegionReferences: true,
      domain,
    });
    const ledgerStack = new LedgerStack(app, "LedgerApi", {
      env: { account, region: "ap-southeast-2" },
      crossRegionReferences: true,
      customDomain: { ...domain, certificate: certStack.certificate },
    });
    certificate = Template.fromStack(certStack);
    ledger = Template.fromStack(ledgerStack);
  });

  it("issues a certificate in us-east-1, validated through the domain's hosted zone", () => {
    certificate.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: "api.example.cloud",
      ValidationMethod: "DNS",
      DomainValidationOptions: [{ DomainName: "api.example.cloud", HostedZoneId: "ZEXAMPLE123" }],
    });
  });

  it("serves the API on that name through CloudFront, with TLS 1.2 or later", () => {
    ledger.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Aliases: ["api.example.cloud"],
        ViewerCertificate: Match.objectLike({
          SslSupportMethod: "sni-only",
          MinimumProtocolVersion: Match.stringLikeRegexp("^TLSv1\\.2"),
        }),
      }),
    });
  });

  it("points the name at the distribution with IPv4 and IPv6 alias records in the existing zone", () => {
    for (const type of ["A", "AAAA"]) {
      ledger.hasResourceProperties("AWS::Route53::RecordSet", {
        Name: "api.example.cloud.",
        Type: type,
        HostedZoneId: "ZEXAMPLE123",
        AliasTarget: Match.objectLike({ DNSName: { "Fn::GetAtt": [Match.anyValue(), "DomainName"] } }),
      });
    }
  });

  it("creates no hosted zone, so the domain's other records are left alone", () => {
    ledger.resourceCountIs("AWS::Route53::HostedZone", 0);
    certificate.resourceCountIs("AWS::Route53::HostedZone", 0);
  });

  it("reports the custom domain as the API URL", () => {
    ledger.hasOutput("ApiUrl", { Value: "https://api.example.cloud" });
  });
});

describe("given no custom domain", () => {
  it("keeps the CloudFront domain only and adds no DNS records", () => {
    const template = Template.fromStack(new LedgerStack(new App(), "LedgerApi", { env: { region: "ap-southeast-2" } }));

    const [distribution] = Object.values(template.findResources("AWS::CloudFront::Distribution"));
    expect(distribution?.Properties.DistributionConfig.Aliases).toBeUndefined();
    template.resourceCountIs("AWS::Route53::RecordSet", 0);
  });
});
