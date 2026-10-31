"""What the stack tests share: synthesizing LedgerStack, and finding a function and its policy in the template."""

import json
from collections.abc import Mapping
from typing import Any

from aws_cdk import App, Environment, Stack
from aws_cdk import aws_certificatemanager as acm
from aws_cdk.assertions import Template

from infra.ledger_stack import CertifiedDomain, LedgerStack

ENV = Environment(account="111111111111", region="ap-southeast-2")
CERTIFICATE_ARN = "arn:aws:acm:us-east-1:111111111111:certificate/abc"

type Resource = Mapping[str, Any]


def synth(app: App | None = None, **kwargs: Any) -> Template:
    return Template.from_stack(LedgerStack(app or App(), "LedgerApi", env=Environment(region=ENV.region), **kwargs))


def custom_domain(app: App) -> CertifiedDomain:
    """The custom domain, with an imported certificate: only its ARN matters here."""
    certificate = acm.Certificate.from_certificate_arn(Stack(app, "Scratch", env=ENV), "Cert", CERTIFICATE_ARN)
    return CertifiedDomain("api.example.cloud", "example.cloud", "ZEXAMPLE123", certificate)


def function_named(template: Template, name: str) -> Resource:
    return next(
        function
        for logical_id, function in template.find_resources("AWS::Lambda::Function").items()
        if logical_id.startswith(f"{name}Function")
    )


def policy_of(template: Template, function: Resource) -> Resource:
    """The document of the policy attached to the function's role."""
    role = function["Properties"]["Role"]["Fn::GetAtt"][0]
    return next(
        policy["Properties"]["PolicyDocument"]
        for policy in template.find_resources("AWS::IAM::Policy").values()
        if any(attached["Ref"] == role for attached in policy["Properties"]["Roles"])
    )


def actions_of(statement: Resource) -> list[str]:
    action = statement["Action"]
    return [action] if isinstance(action, str) else list(action)


def as_text(value: Any) -> str:
    return json.dumps(value)
