from dataclasses import dataclass
from typing import Any

from aws_cdk import Stack
from aws_cdk.aws_certificatemanager import Certificate, CertificateValidation, ICertificate
from aws_cdk.aws_route53 import HostedZone
from constructs import Construct


@dataclass(frozen=True)
class CustomDomain:
    """A name for the API inside a Route 53 hosted zone that already exists (and is managed elsewhere)."""

    domain_name: str  # e.g. api.haoran.cloud
    zone_name: str  # The existing zone, e.g. haoran.cloud.
    hosted_zone_id: str


class CertificateStack(Stack):
    """
    The TLS certificate for the custom domain. CloudFront only accepts certificates from
    us-east-1, so this stack lives there while the API stays in ap-southeast-2.
    """

    certificate: ICertificate

    def __init__(self, scope: Construct, id: str, *, domain: CustomDomain, **kwargs: Any) -> None:
        super().__init__(scope, id, **kwargs)
        # Imported by ID rather than looked up: a lookup caches the account ID in cdk.context.json.
        zone = HostedZone.from_hosted_zone_attributes(
            self, "Zone", zone_name=domain.zone_name, hosted_zone_id=domain.hosted_zone_id
        )
        # ACM adds and checks the validation record in the zone itself. Public certificates are free.
        self.certificate = Certificate(
            self, "ApiCertificate", domain_name=domain.domain_name, validation=CertificateValidation.from_dns(zone)
        )
