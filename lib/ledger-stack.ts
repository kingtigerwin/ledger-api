import * as path from "node:path";
import { Arn, Duration, Stack, type StackProps } from "aws-cdk-lib";
import { CfnStage, HttpApi, HttpMethod, HttpStage } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaAuthorizer, HttpLambdaResponseType } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { AttributeType, Billing, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Architecture, LoggingFormat, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, type NodejsFunctionProps } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import { usersTableKeys } from "../src/auth/users-table";

const SIGNING_SECRET_PARAM = "/ledger-api/jwt-signing-secret";
// Unauthenticated routes that anyone on the internet can call, so they get tighter throttling.
const PUBLIC_AUTH_ROUTES = ["register", "login", "refresh", "logout"].map((name) => `/api/v1/auth/${name}`);

export class LedgerStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const usersTable = new TableV2(this, "UsersTable", {
      partitionKey: { name: usersTableKeys.partitionKey, type: AttributeType.STRING },
      sortKey: { name: usersTableKeys.sortKey, type: AttributeType.STRING },
      billing: Billing.onDemand(),
      timeToLiveAttribute: "ttl",
    });

    const signingSecretArn = Arn.format(
      { service: "ssm", resource: "parameter", resourceName: SIGNING_SECRET_PARAM.slice(1) },
      this,
    );
    const makeFunction = (name: string, entry: string, props: Partial<NodejsFunctionProps> = {}) => {
      const fn = new NodejsFunction(this, `${name}Function`, {
        entry: path.join(__dirname, "../src", entry),
        runtime: Runtime.NODEJS_22_X,
        architecture: Architecture.ARM_64,
        timeout: Duration.seconds(10),
        loggingFormat: LoggingFormat.JSON,
        logGroup: new LogGroup(this, `${name}Logs`, { retention: RetentionDays.TWO_WEEKS }),
        bundling: { minify: true, sourceMap: true },
        ...props,
        environment: { SIGNING_SECRET_PARAM, ...props.environment },
      });
      fn.addToRolePolicy(new PolicyStatement({ actions: ["ssm:GetParameter"], resources: [signingSecretArn] }));
      return fn;
    };

    const authFunction = makeFunction("Auth", "auth/lambda.ts", {
      // scrypt needs about 128 MB per hash; more memory also means more CPU, so hashing is faster.
      memorySize: 512,
      environment: { USERS_TABLE: usersTable.tableName },
    });
    usersTable.grantReadWriteData(authFunction);

    const authorizer = new HttpLambdaAuthorizer(
      "BearerAuthorizer",
      makeFunction("Authorizer", "auth/authorizer-lambda.ts", { memorySize: 256 }),
      {
        responseTypes: [HttpLambdaResponseType.SIMPLE],
        // An expired token can keep working for at most this long after it expires.
        resultsCacheTtl: Duration.seconds(60),
      },
    );

    const api = new HttpApi(this, "Api", { createDefaultStage: false });
    const auth = new HttpLambdaIntegration("AuthIntegration", authFunction);
    const publicRoutes = PUBLIC_AUTH_ROUTES.flatMap((routePath) =>
      api.addRoutes({ path: routePath, methods: [HttpMethod.POST], integration: auth }),
    );
    api.addRoutes({ path: "/api/v1/auth/me", methods: [HttpMethod.GET], integration: auth, authorizer });

    const stage = new HttpStage(this, "DefaultStage", {
      httpApi: api,
      stageName: "$default",
      autoDeploy: true,
      throttle: { rateLimit: 50, burstLimit: 100 },
    });
    // RouteSettings is untyped JSON, so CDK passes keys through as written: they must be PascalCase.
    // Per-route limits refer to routes by key, so the routes must exist before the stage.
    (stage.node.defaultChild as CfnStage).routeSettings = Object.fromEntries(
      PUBLIC_AUTH_ROUTES.map((routePath) => [`POST ${routePath}`, { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 }]),
    );
    publicRoutes.forEach((route) => stage.node.addDependency(route));
  }
}
