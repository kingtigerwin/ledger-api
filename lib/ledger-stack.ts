import * as path from "node:path";
import { Arn, Duration, Stack, type StackProps } from "aws-cdk-lib";
import { CfnStage, HttpApi, HttpMethod, HttpStage } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { AttributeType, Billing, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Architecture, LoggingFormat, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import { usersTableKeys } from "../src/auth/users-table";

const SIGNING_SECRET_PARAM = "/ledger-api/jwt-signing-secret";
const AUTH_ROUTES = ["/api/v1/auth/register", "/api/v1/auth/login"];

export class LedgerStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const usersTable = new TableV2(this, "UsersTable", {
      partitionKey: { name: usersTableKeys.partitionKey, type: AttributeType.STRING },
      sortKey: { name: usersTableKeys.sortKey, type: AttributeType.STRING },
      billing: Billing.onDemand(),
    });

    const authFunction = new NodejsFunction(this, "AuthFunction", {
      entry: path.join(__dirname, "../src/auth/lambda.ts"),
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      // scrypt needs about 128 MB per hash; more memory also means more CPU, so hashing is faster.
      memorySize: 512,
      timeout: Duration.seconds(10),
      loggingFormat: LoggingFormat.JSON,
      logGroup: new LogGroup(this, "AuthLogs", { retention: RetentionDays.TWO_WEEKS }),
      environment: { USERS_TABLE: usersTable.tableName, SIGNING_SECRET_PARAM },
      bundling: { minify: true, sourceMap: true },
    });
    usersTable.grantReadWriteData(authFunction);
    authFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [Arn.format({ service: "ssm", resource: "parameter", resourceName: SIGNING_SECRET_PARAM.slice(1) }, this)],
      }),
    );

    const api = new HttpApi(this, "Api", { createDefaultStage: false });
    const authIntegration = new HttpLambdaIntegration("AuthIntegration", authFunction);
    const routes = AUTH_ROUTES.flatMap((routePath) =>
      api.addRoutes({ path: routePath, methods: [HttpMethod.POST], integration: authIntegration }),
    );

    const stage = new HttpStage(this, "DefaultStage", {
      httpApi: api,
      stageName: "$default",
      autoDeploy: true,
      throttle: { rateLimit: 50, burstLimit: 100 },
    });
    // RouteSettings is untyped JSON, so CDK passes keys through as written: they must be PascalCase.
    // Per-route limits refer to routes by key, so the routes must exist before the stage.
    (stage.node.defaultChild as CfnStage).routeSettings = Object.fromEntries(
      AUTH_ROUTES.map((routePath) => [`POST ${routePath}`, { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 }]),
    );
    routes.forEach((route) => stage.node.addDependency(route));
  }
}
