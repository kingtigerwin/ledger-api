import pytest
from aws_cdk import App, Environment
from aws_cdk.assertions import Match, Template

from infra.ci_access_stack import CiAccessStack
from tests.infra.stacks import as_text


@pytest.fixture(scope="module")
def template() -> Template:
    stack = CiAccessStack(
        App(),
        "LedgerApiCiAccess",
        env=Environment(account="123456789012", region="ap-southeast-2"),
        github_subject_prefix="repo:kingtigerwin@9473411/ledger-api@1434244010",
    )
    return Template.from_stack(stack)


class TestGivenTheCiAccessStack:
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
                                        # GitHub's immutable subject format: owner and repo, with their IDs.
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
        statements = [
            statement
            for policy in template.find_resources("AWS::IAM::Policy").values()
            for statement in policy["Properties"]["PolicyDocument"]["Statement"]
        ]
        by_action = {statement["Action"]: statement for statement in statements}

        assert sorted(by_action) == ["ssm:GetParameter", "sts:AssumeRole"]
        assert ":role/cdk-hnb659fds-*" in as_text(by_action["sts:AssumeRole"]["Resource"])
        assert "parameter/ledger-api/admin-password" in as_text(by_action["ssm:GetParameter"]["Resource"])

    def test_outputs_the_role_arn_for_the_github_workflow(self, template: Template) -> None:
        template.has_output("DeployRoleArn", {})
