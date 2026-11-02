from typing import Any

from aws_cdk import Arn, ArnComponents, CfnOutput, Duration, Stack
from aws_cdk.aws_iam import CfnOIDCProvider, PolicyStatement, Role, WebIdentityPrincipal
from constructs import Construct

from ledger_api.config import ADMIN_PASSWORD_PARAM

GITHUB_OIDC = "token.actions.githubusercontent.com"


class CiAccessStack(Stack):
    """
    Deployed once from a laptop: lets GitHub Actions on the repo's main branch deploy, with no
    stored AWS keys. CI can't create the role it signs in with, which is why this is separate.

    `github_subject_prefix` is the start of the `sub` claim in the repo's GitHub OIDC tokens. Repos using
    GitHub's immutable subject format send `repo:<owner>@<ownerId>/<repo>@<repoId>`; look it up with
    `gh api repos/<owner>/<repo>/actions/oidc/customization/sub` (`sub_claim_prefix`).
    """

    def __init__(self, scope: Construct, id: str, *, github_subject_prefix: str, **kwargs: Any) -> None:
        super().__init__(scope, id, **kwargs)

        provider = CfnOIDCProvider(
            self, "GitHubOidc", url=f"https://{GITHUB_OIDC}", client_id_list=["sts.amazonaws.com"]
        )

        role = Role(
            self,
            "DeployRole",
            role_name="ledger-api-github-deploy",
            max_session_duration=Duration.hours(1),
            # jsii's generated interfaces don't satisfy pyright's protocol check, though the class implements this one.
            assumed_by=WebIdentityPrincipal(  # pyright: ignore[reportArgumentType]
                provider.attr_arn,
                {
                    "StringEquals": {
                        f"{GITHUB_OIDC}:aud": "sts.amazonaws.com",
                        f"{GITHUB_OIDC}:sub": f"{github_subject_prefix}:ref:refs/heads/main",
                    }
                },
            ),
        )
        # Least privilege: `cdk deploy` works by assuming the roles `cdk bootstrap` created,
        # so this role needs nothing else to deploy.
        role.add_to_policy(
            PolicyStatement(
                actions=["sts:AssumeRole"],
                resources=[
                    Arn.format(
                        ArnComponents(service="iam", region="", resource="role", resource_name="cdk-hnb659fds-*"), self
                    )
                ],
            )
        )
        # The smoke test logs in as the admin to approve its test user.
        role.add_to_policy(
            PolicyStatement(
                actions=["ssm:GetParameter"],
                resources=[
                    Arn.format(
                        ArnComponents(
                            service="ssm", resource="parameter", resource_name=ADMIN_PASSWORD_PARAM.removeprefix("/")
                        ),
                        self,
                    )
                ],
            )
        )

        CfnOutput(self, "DeployRoleArn", value=role.role_arn)
