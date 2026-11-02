"""What the stack tests share: a placeholder environment, and picking resources out of a template."""

from collections.abc import Mapping
from typing import Any

from aws_cdk import App, Environment, Stack
from aws_cdk.assertions import Template
from aws_cdk.aws_certificatemanager import Certificate

from infra.certificate_stack import CustomDomain
from infra.ledger_stack import CertifiedDomain, LedgerStack

ENV = Environment(account="111111111111", region="ap-southeast-2")
# No account: most stacks here never need to name one.
REGION_ONLY = Environment(region="ap-southeast-2")
DOMAIN = CustomDomain(domain_name="api.example.cloud", zone_name="example.cloud", hosted_zone_id="ZEXAMPLE123")
CERTIFICATE_ARN = "arn:aws:acm:us-east-1:111111111111:certificate/abc"


def quick_app(**context: Any) -> App:
    """Synthesizing would otherwise build the Python bundles with uv, which takes seconds per stack."""
    return App(context={"aws:cdk:bundling-stacks": [], **context})


def certified_domain(app: App) -> CertifiedDomain:
    """The custom domain, with an imported certificate: only its ARN matters here."""
    certificate = Certificate.from_certificate_arn(Stack(app, "Scratch", env=ENV), "Cert", CERTIFICATE_ARN)
    return CertifiedDomain(DOMAIN.domain_name, DOMAIN.zone_name, DOMAIN.hosted_zone_id, certificate)


def synth(**props: Any) -> Template:
    return Template.from_stack(LedgerStack(quick_app(), "LedgerApi", env=REGION_ONLY, **props))


def found(template: Template, resource_type: str, prefix: str) -> Mapping[str, Any]:
    """The first resource of a type whose logical ID starts with `prefix`."""
    return next(r for id, r in template.find_resources(resource_type).items() if id.startswith(prefix))


def function_policy(template: Template, function: Mapping[str, Any]) -> Mapping[str, Any]:
    """The policy document attached to a function's role."""
    role = function["Properties"]["Role"]["Fn::GetAtt"][0]
    policies = template.find_resources("AWS::IAM::Policy").values()
    return next(p for p in policies if {"Ref": role} in p["Properties"]["Roles"])["Properties"]["PolicyDocument"]


def actions_of(statement: Mapping[str, Any]) -> list[str]:
    action: str | list[str] = statement["Action"]
    return [action] if isinstance(action, str) else action
