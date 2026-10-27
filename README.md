# ledger-api

A serverless API where customers record their spending: TypeScript, AWS CDK, Lambda, API Gateway (HTTP API) behind CloudFront, and DynamoDB. Designed to run at $0/month. The design is in [`docs/design.md`](docs/design.md), and the API is described by the OpenAPI spec served at `/api/openapi.json`.

## Develop

```sh
npm ci
npm run db:up             # DynamoDB Local in Docker, for integration tests
npm run typecheck && npm run lint
npm test                  # unit + integration
```

## First deploy (once, from your machine)

GitHub Actions deploys `main` using GitHub's OIDC login, so no AWS keys are stored in GitHub. It can't create the role it signs in with, so that role is deployed once by hand.

1. With AWS credentials for the target account in your shell:

   ```sh
   npx cdk bootstrap aws://<account-id>/ap-southeast-2
   npx cdk deploy LedgerApiCiAccess
   ```

   Note the `DeployRoleArn` output.

2. In the GitHub repo's **Settings → Secrets and variables → Actions**, add:

   | Kind | Name | Value |
   |---|---|---|
   | Secret | `AWS_DEPLOY_ROLE_ARN` | the `DeployRoleArn` output (a secret, so the account ID in it stays out of the public logs) |
   | Secret | `SMOKE_TEST_PASSWORD` | any long random string, e.g. `openssl rand -base64 24`; the smoke test's user signs up with it |
   | Variable | `DEPLOY_ENABLED` | `true` (turns the deploy job on) |
   | Variable | `ALARM_EMAIL` | where to email alarms (optional) |

3. Push to `main` (or re-run the CI workflow on `main`). The `deploy` job runs `cdk deploy LedgerApi` and then the smoke test against the CloudFront URL (`ApiUrl` output).

4. If you set `ALARM_EMAIL`, confirm the subscription email AWS sends.

## After deploying

- The root admin is `sisi`. Its password was generated on first deploy:

  ```sh
  aws ssm get-parameter --name /ledger-api/admin-password --with-decryption \
    --query Parameter.Value --output text --region ap-southeast-2
  ```

- Run the smoke test yourself:

  ```sh
  API_URL=https://<distribution>.cloudfront.net SMOKE_TEST_PASSWORD=... npm run smoke
  ```

## Cost

Everything is on-demand and within the AWS free tier at household traffic: Lambda, DynamoDB on-demand, HTTP API, CloudFront, SSM standard parameters, four CloudWatch alarms (the free tier allows 10), two-week log retention. The CDK bootstrap bucket holds a few MB of deployment assets.
