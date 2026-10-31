import os
import sys
from pathlib import Path

# `cdk` runs this file as a script; make `infra` importable as a package.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aws_cdk import App, Environment

from infra.certificate_stack import CertificateStack, CustomDomain
from infra.ci_access_stack import CiAccessStack
from infra.ledger_stack import CertifiedDomain, GoogleClient, LedgerStack

app = App()
account = os.environ.get("CDK_DEFAULT_ACCOUNT")
env = Environment(account=account, region="ap-southeast-2")

# Optional: serve the API on a name in an existing Route 53 zone (see cdk.json). The certificate
# must come from us-east-1 for CloudFront, hence the second stack and cross-region references.
domain: dict[str, str] | None = app.node.try_get_context("customDomain") or None
google_client_id: str | None = app.node.try_get_context("googleClientId") or None
if domain:
    custom_domain = CustomDomain(domain["domainName"], domain["zoneName"], domain["hostedZoneId"])
    certificate_stack = CertificateStack(
        app,
        "LedgerApiCertificate",
        env=Environment(account=account, region="us-east-1"),
        cross_region_references=True,
        domain=custom_domain,
    )
    LedgerStack(
        app,
        "LedgerApi",
        env=env,
        cross_region_references=True,
        custom_domain=CertifiedDomain(
            custom_domain.domain_name,
            custom_domain.zone_name,
            custom_domain.hosted_zone_id,
            certificate_stack.certificate,
        ),
        # Optional: email customers from this address in the domain's zone (see cdk.json).
        email_from=app.node.try_get_context("emailFrom") or None,
        # A personal address, so it comes from a GitHub variable at deploy time, not cdk.json.
        admin_email=app.node.try_get_context("adminEmail") or None,
        # Optional: ledger-ui's admin page, for the admin's approve or reject link (see cdk.json).
        admin_page_url=app.node.try_get_context("adminPageUrl") or None,
        # Optional: sign-in with Google (see cdk.json and the README). An empty client ID leaves it off.
        google_sign_in=GoogleClient(google_client_id, app.node.get_context("googleRedirectUri"))
        if google_client_id
        else None,
    )
else:
    LedgerStack(app, "LedgerApi", env=env)
# Deployed once by hand; see README. The repo uses GitHub's immutable OIDC subject, which
# includes the owner and repo IDs, so the trust still holds if either is renamed.
CiAccessStack(
    app, "LedgerApiCiAccess", env=env, github_subject_prefix="repo:kingtigerwin@9473411/ledger-api@1434244010"
)
app.synth()
