import { Stack, type StackProps } from "aws-cdk-lib";
import { Certificate, CertificateValidation, type ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import { HostedZone } from "aws-cdk-lib/aws-route53";
import type { Construct } from "constructs";

/** A name for the API inside a Route 53 hosted zone that already exists (and is managed elsewhere). */
export interface CustomDomain {
  /** e.g. api.haoran.cloud */
  domainName: string;
  /** The existing zone, e.g. haoran.cloud. */
  zoneName: string;
  hostedZoneId: string;
}

/**
 * The TLS certificate for the custom domain. CloudFront only accepts certificates from
 * us-east-1, so this stack lives there while the API stays in ap-southeast-2.
 */
export class CertificateStack extends Stack {
  readonly certificate: ICertificate;

  constructor(scope: Construct, id: string, props: StackProps & { domain: CustomDomain }) {
    super(scope, id, props);
    const { domainName, zoneName, hostedZoneId } = props.domain;
    // Imported by ID rather than looked up: a lookup caches the account ID in cdk.context.json.
    const zone = HostedZone.fromHostedZoneAttributes(this, "Zone", { zoneName, hostedZoneId });
    // ACM adds and checks the validation record in the zone itself. Public certificates are free.
    this.certificate = new Certificate(this, "ApiCertificate", {
      domainName,
      validation: CertificateValidation.fromDns(zone),
    });
  }
}
