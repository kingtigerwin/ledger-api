import pytest
from aws_cdk import Environment
from aws_cdk.assertions import Match, Template

from infra.certificate_stack import CertificateStack
from infra.ledger_stack import CertifiedDomain, LedgerStack
from tests.infra.support import DOMAIN, quick_app, synth

# A placeholder account: cross-region references need both stacks to name one.
ACCOUNT = "111111111111"


class TestGivenACustomDomain:
    @pytest.fixture(scope="class")
    @classmethod
    def templates(cls) -> tuple[Template, Template]:
        app = quick_app()
        certificate_stack = CertificateStack(
            app,
            "LedgerApiCertificate",
            domain=DOMAIN,
            env=Environment(account=ACCOUNT, region="us-east-1"),
            cross_region_references=True,
        )
        ledger_stack = LedgerStack(
            app,
            "LedgerApi",
            custom_domain=CertifiedDomain(
                DOMAIN.domain_name, DOMAIN.zone_name, DOMAIN.hosted_zone_id, certificate_stack.certificate
            ),
            env=Environment(account=ACCOUNT, region="ap-southeast-2"),
            cross_region_references=True,
        )
        return Template.from_stack(certificate_stack), Template.from_stack(ledger_stack)

    def test_issues_a_certificate_validated_through_the_domains_hosted_zone(
        self, templates: tuple[Template, Template]
    ) -> None:
        templates[0].has_resource_properties(
            "AWS::CertificateManager::Certificate",
            {
                "DomainName": "api.example.cloud",
                "ValidationMethod": "DNS",
                "DomainValidationOptions": [{"DomainName": "api.example.cloud", "HostedZoneId": "ZEXAMPLE123"}],
            },
        )

    def test_serves_the_api_on_that_name_through_cloudfront_with_tls_1_2_or_later(
        self, templates: tuple[Template, Template]
    ) -> None:
        templates[1].has_resource_properties(
            "AWS::CloudFront::Distribution",
            {
                "DistributionConfig": Match.object_like(
                    {
                        "Aliases": ["api.example.cloud"],
                        "ViewerCertificate": Match.object_like(
                            {
                                "SslSupportMethod": "sni-only",
                                "MinimumProtocolVersion": Match.string_like_regexp(r"^TLSv1\.2"),
                            }
                        ),
                    }
                )
            },
        )

    @pytest.mark.parametrize("record_type", ["A", "AAAA"])
    def test_points_the_name_at_the_distribution_in_the_existing_zone(
        self, templates: tuple[Template, Template], record_type: str
    ) -> None:
        templates[1].has_resource_properties(
            "AWS::Route53::RecordSet",
            {
                "Name": "api.example.cloud.",
                "Type": record_type,
                "HostedZoneId": "ZEXAMPLE123",
                "AliasTarget": Match.object_like({"DNSName": {"Fn::GetAtt": [Match.any_value(), "DomainName"]}}),
            },
        )

    def test_creates_no_hosted_zone_so_the_domains_other_records_are_left_alone(
        self, templates: tuple[Template, Template]
    ) -> None:
        templates[0].resource_count_is("AWS::Route53::HostedZone", 0)
        templates[1].resource_count_is("AWS::Route53::HostedZone", 0)

    def test_reports_the_custom_domain_as_the_api_url(self, templates: tuple[Template, Template]) -> None:
        templates[1].has_output("ApiUrl", {"Value": "https://api.example.cloud"})


class TestGivenNoCustomDomain:
    def test_keeps_the_cloudfront_domain_only_and_adds_no_dns_records(self) -> None:
        template = synth()

        [distribution] = template.find_resources("AWS::CloudFront::Distribution").values()
        assert "Aliases" not in distribution["Properties"]["DistributionConfig"]
        template.resource_count_is("AWS::Route53::RecordSet", 0)
