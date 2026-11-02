import json

import pytest
from aws_cdk.assertions import Match, Template

from infra.ci_access_stack import CiAccessStack
from tests.infra.support import ENV, quick_app


@pytest.fixture(scope="module")
def template() -> Template:
    stack = CiAccessStack(
        quick_app(),
        "LedgerApiCiAccess",
        github_subject_prefix="repo:kingtigerwin@9473411/ledger-api@1434244010",
        env=ENV,
    )
    return Template.from_stack(stack)


class TestCiAccessStack:
    def test_trusts_githubs_oidc_tokens(self, template: Template) -> None:
        template.has_resource_properties(
            "AWS::IAM::OIDCProvider",
            {"Url": "https://token.actions.githubusercontent.com", "ClientIdList": ["sts.amazonaws.com"]},
        )

    def test_lets_only_this_repos_main_branch_assume_the_deploy_role(self, template: Template) -> None:
        template.has_resource_properties(
            "AWS::IAM::Role",
            {
                "AssumeRolePolicyDocument": {
                    "Statement": [
                        Match.object_like(
                            {
                                "Action": "sts:AssumeRoleWithWebIdentity",
                                "Condition": {
                                    "StringEquals": {
                                        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                                        # GitHub's immutable subject format: names with their numeric IDs.
                                        "token.actions.githubusercontent.com:sub": (
                                            "repo:kingtigerwin@9473411/ledger-api@1434244010:ref:refs/heads/main"
                                        ),
                                    }
                                },
                            }
                        )
                    ]
                }
            },
        )

    def test_can_only_assume_cdks_bootstrap_roles_and_read_the_admin_password(self, template: Template) -> None:
        policies = template.find_resources("AWS::IAM::Policy").values()
        statements = {s["Action"]: s for p in policies for s in p["Properties"]["PolicyDocument"]["Statement"]}

        assert sorted(statements) == ["ssm:GetParameter", "sts:AssumeRole"]
        assert ":role/cdk-hnb659fds-*" in json.dumps(statements["sts:AssumeRole"]["Resource"])
        assert "parameter/ledger-api/admin-password" in json.dumps(statements["ssm:GetParameter"]["Resource"])

    def test_outputs_the_role_arn_for_the_github_workflow(self, template: Template) -> None:
        template.has_output("DeployRoleArn", {})
