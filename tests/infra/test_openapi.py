from aws_cdk.assertions import Template

from infra.ledger_stack import LedgerStack
from ledger_api.docs.openapi import build_openapi
from tests.infra.support import REGION_ONLY, quick_app


class TestTheOpenApiSpec:
    def test_documents_exactly_the_routes_the_stack_deploys(self) -> None:
        template = Template.from_stack(LedgerStack(quick_app(), "LedgerApi", env=REGION_ONLY))
        route_keys = [r["Properties"]["RouteKey"] for r in template.find_resources("AWS::ApiGatewayV2::Route").values()]

        documented = [
            f"{method.upper()} {path}" for path, operations in build_openapi()["paths"].items() for method in operations
        ]

        assert sorted(documented) == sorted(route_keys)
