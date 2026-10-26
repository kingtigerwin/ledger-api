import * as path from "node:path";
import { Arn, CustomResource, Duration, Stack, type StackProps } from "aws-cdk-lib";
import { CfnStage, HttpApi, HttpMethod, HttpStage } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaAuthorizer, HttpLambdaResponseType } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { AttributeType, Billing, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Architecture, LoggingFormat, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, type NodejsFunctionProps } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Provider } from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";
import { usersTableKeys } from "../src/auth/users-table";
import { ADMIN_PASSWORD_PARAM, SIGNING_SECRET_PARAM } from "../src/config";
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

    const parameterArn = (name: string) =>
      Arn.format({ service: "ssm", resource: "parameter", resourceName: name.slice(1) }, this);
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
      });
      return fn;
    };
    const canReadSigningSecret = (fn: NodejsFunction) =>
      fn.addToRolePolicy(
        new PolicyStatement({ actions: ["ssm:GetParameter"], resources: [parameterArn(SIGNING_SECRET_PARAM)] }),
      );

    const authFunction = makeFunction("Auth", "auth/lambda.ts", {
      // scrypt needs about 128 MB per hash; more memory also means more CPU, so hashing is faster.
      memorySize: 512,
      environment: { USERS_TABLE: usersTable.tableName },
    });
    usersTable.grantReadWriteData(authFunction);
    canReadSigningSecret(authFunction);

    const authorizerFunction = makeFunction("Authorizer", "auth/authorizer-lambda.ts", { memorySize: 256 });
    canReadSigningSecret(authorizerFunction);
    const authorizer = new HttpLambdaAuthorizer("BearerAuthorizer", authorizerFunction, {
      responseTypes: [HttpLambdaResponseType.SIMPLE],
      // An expired token can keep working for at most this long after it expires.
      resultsCacheTtl: Duration.seconds(60),
    });

    // Creates the signing secret, the admin password and the admin user on first deploy.
    const bootstrapFunction = makeFunction("Bootstrap", "bootstrap/lambda.ts", {
      memorySize: 512, // hashes the admin password with scrypt
      timeout: Duration.seconds(30),
      environment: { USERS_TABLE: usersTable.tableName },
    });
    usersTable.grantReadWriteData(bootstrapFunction);
    bootstrapFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:PutParameter"],
        resources: [parameterArn(SIGNING_SECRET_PARAM), parameterArn(ADMIN_PASSWORD_PARAM)],
      }),
    );
    const bootstrap = new CustomResource(this, "Bootstrap", {
      serviceToken: new Provider(this, "BootstrapProvider", { onEventHandler: bootstrapFunction }).serviceToken,
    });

    const adminFunction = makeFunction("Admin", "admin/lambda.ts", {
      memorySize: 256,
      environment: { USERS_TABLE: usersTable.tableName },
    });
    usersTable.grantReadWriteData(adminFunction);

    const api = new HttpApi(this, "Api", { createDefaultStage: false });
    const auth = new HttpLambdaIntegration("AuthIntegration", authFunction);
    const publicRoutes = PUBLIC_AUTH_ROUTES.flatMap((routePath) =>
      api.addRoutes({ path: routePath, methods: [HttpMethod.POST], integration: auth }),
    );
    api.addRoutes({ path: "/api/v1/auth/me", methods: [HttpMethod.GET], integration: auth, authorizer });
    const admin = new HttpLambdaIntegration("AdminIntegration", adminFunction);
    api.addRoutes({ path: "/api/v1/admin/users", methods: [HttpMethod.GET], integration: admin, authorizer });
    for (const action of ["enable", "disable"]) {
      api.addRoutes({
        path: `/api/v1/admin/users/{id}/${action}`,
        methods: [HttpMethod.POST],
        integration: admin,
        authorizer,
      });
    }

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
    // Don't serve traffic before the signing secret exists.
    stage.node.addDependency(bootstrap);
  }
}
