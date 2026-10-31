import pytest
from aws_cdk import App, Environment
from aws_cdk.assertions import Match, Template

from infra.certificate_stack import CertificateStack, CustomDomain
from infra.ledger_stack import CertifiedDomain, LedgerStack
from tests.infra.stacks import synth

# A placeholder account: cross-region references need both stacks to name one.
ACCOUNT = "111111111111"
DOMAIN = CustomDomain("api.example.cloud", "example.cloud", "ZEXAMPLE123")


@pytest.fixture(scope="module")
def stacks() -> tuple[Template, Template]:
    app = App()
    certificate_stack = CertificateStack(
        app,
        "LedgerApiCertificate",
        env=Environment(account=ACCOUNT, region="us-east-1"),
        cross_region_references=True,
        domain=DOMAIN,
    )
    ledger_stack = LedgerStack(
        app,
        "LedgerApi",
        env=Environment(account=ACCOUNT, region="ap-southeast-2"),
        cross_region_references=True,
        custom_domain=CertifiedDomain(
            DOMAIN.domain_name, DOMAIN.zone_name, DOMAIN.hosted_zone_id, certificate_stack.certificate
        ),
    )
    return Template.from_stack(certificate_stack), Template.from_stack(ledger_stack)


@pytest.fixture(scope="module")
def certificate(stacks: tuple[Template, Template]) -> Template:
    return stacks[0]


@pytest.fixture(scope="module")
def ledger(stacks: tuple[Template, Template]) -> Template:
    return stacks[1]


class TestGivenACustomDomain:
    def test_issues_a_certificate_in_us_east_1_validated_through_the_hosted_zone(self, certificate: Template) -> None:
        certificate.has_resource_properties(
            "AWS::CertificateManager::Certificate",
            {
                "DomainName": "api.example.cloud",
                "ValidationMethod": "DNS",
                "DomainValidationOptions": [{"DomainName": "api.example.cloud", "HostedZoneId": "ZEXAMPLE123"}],
            },
        )

    def test_serves_the_api_on_that_name_through_cloudfront_with_tls_1_2_or_later(self, ledger: Template) -> None:
        ledger.has_resource_properties(
            "AWS::CloudFront::Distribution",
            {
                "DistributionConfig": Match.object_like(
                    {
                        "Aliases": ["api.example.cloud"],
                        "ViewerCertificate": Match.object_like(
                            {
                                "SslSupportMethod": "sni-only",
                                "MinimumProtocolVersion": Match.string_like_regexp("^TLSv1\\.2"),
                            }
                        ),
                    }
                )
            },
        )

    @pytest.mark.parametrize("record_type", ["A", "AAAA"])
    def test_points_the_name_at_the_distribution_in_the_existing_zone(self, ledger: Template, record_type: str) -> None:
        ledger.has_resource_properties(
            "AWS::Route53::RecordSet",
            {
                "Name": "api.example.cloud.",
                "Type": record_type,
                "HostedZoneId": "ZEXAMPLE123",
                "AliasTarget": Match.object_like({"DNSName": {"Fn::GetAtt": [Match.any_value(), "DomainName"]}}),
            },
        )

    def test_creates_no_hosted_zone_so_the_domains_other_records_are_left_alone(
        self, ledger: Template, certificate: Template
    ) -> None:
        ledger.resource_count_is("AWS::Route53::HostedZone", 0)
        certificate.resource_count_is("AWS::Route53::HostedZone", 0)

    def test_reports_the_custom_domain_as_the_api_url(self, ledger: Template) -> None:
        ledger.has_output("ApiUrl", {"Value": "https://api.example.cloud"})


class TestGivenNoCustomDomain:
    def test_keeps_the_cloudfront_domain_only_and_adds_no_dns_records(self) -> None:
        template = synth()

        [distribution] = template.find_resources("AWS::CloudFront::Distribution").values()
        assert "Aliases" not in distribution["Properties"]["DistributionConfig"]
        template.resource_count_is("AWS::Route53::RecordSet", 0)
