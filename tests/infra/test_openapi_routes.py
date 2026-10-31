from ledger_api.docs.openapi import build_openapi
from tests.infra.stacks import synth


class TestGivenTheOpenApiSpec:
    def test_documents_exactly_the_routes_the_stack_deploys(self) -> None:
        routes = synth().find_resources("AWS::ApiGatewayV2::Route").values()

        documented = [
            f"{method.upper()} {path}" for path, operations in build_openapi()["paths"].items() for method in operations
        ]

        assert sorted(documented) == sorted(route["Properties"]["RouteKey"] for route in routes)
