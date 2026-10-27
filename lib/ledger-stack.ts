import * as path from "node:path";
import { Arn, CfnOutput, CustomResource, Duration, Stack, type StackProps } from "aws-cdk-lib";
import { CfnStage, HttpApi, HttpMethod, HttpStage } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaAuthorizer, HttpLambdaResponseType } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import {
  AllowedMethods,
  type BehaviorOptions,
  CachePolicy,
  Distribution,
  OriginRequestPolicy,
  PriceClass,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { AttributeType, Billing, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Architecture, LoggingFormat, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, type NodejsFunctionProps } from "aws-cdk-lib/aws-lambda-nodejs";
import { FilterPattern, LogGroup, MetricFilter, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Topic } from "aws-cdk-lib/aws-sns";
import { EmailSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { Provider } from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";
import { usersTableKeys } from "../src/auth/users-table";
import { ADMIN_PASSWORD_PARAM, SIGNING_SECRET_PARAM } from "../src/config";
import { dataTableKeys } from "../src/data/data-table";
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

    const dataTable = new TableV2(this, "DataTable", {
      partitionKey: { name: dataTableKeys.partitionKey, type: AttributeType.STRING },
      sortKey: { name: dataTableKeys.sortKey, type: AttributeType.STRING },
      billing: Billing.onDemand(),
      globalSecondaryIndexes: dataTableKeys.indexes.map((index) => ({
        indexName: index.name,
        partitionKey: { name: index.partitionKey, type: AttributeType.STRING },
        sortKey: { name: index.sortKey, type: AttributeType.STRING },
      })),
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

    const dataFunction = makeFunction("Data", "data/lambda.ts", {
      memorySize: 256,
      environment: { DATA_TABLE: dataTable.tableName },
    });
    dataTable.grantReadWriteData(dataFunction);
    canReadSigningSecret(dataFunction);

    const docsFunction = makeFunction("Docs", "docs/lambda.ts", { memorySize: 128 });

    const api = new HttpApi(this, "Api", { createDefaultStage: false });
    const auth = new HttpLambdaIntegration("AuthIntegration", authFunction);
    const publicRoutes = PUBLIC_AUTH_ROUTES.flatMap((routePath) =>
      api.addRoutes({ path: routePath, methods: [HttpMethod.POST], integration: auth }),
    );
    api.addRoutes({ path: "/api/v1/auth/me", methods: [HttpMethod.GET], integration: auth, authorizer });
    api.addRoutes({
      path: "/api/openapi.json",
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration("DocsIntegration", docsFunction),
    });
    const data = new HttpLambdaIntegration("DataIntegration", dataFunction);
    const dataRoutes: [string, HttpMethod[]][] = [
      ["/api/v1/transactions", [HttpMethod.POST, HttpMethod.GET]],
      // A static segment wins over {id}, so /summary never reaches the {id} route.
      ["/api/v1/transactions/summary", [HttpMethod.GET]],
      ["/api/v1/transactions/{id}", [HttpMethod.GET, HttpMethod.PATCH, HttpMethod.DELETE]],
      ["/api/v1/admin/users/{id}/transactions", [HttpMethod.GET]],
    ];
    for (const [routePath, methods] of dataRoutes) {
      api.addRoutes({ path: routePath, methods, integration: data, authorizer });
    }
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

    // One origin for the browser: /api/* goes to API Gateway, so the refresh cookie is first-party.
    // A UI can later become the default behaviour without changing the API's address.
    const apiBehavior: BehaviorOptions = {
      origin: new HttpOrigin(`${api.apiId}.execute-api.${this.region}.${this.urlSuffix}`),
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: AllowedMethods.ALLOW_ALL,
      cachePolicy: CachePolicy.CACHING_DISABLED,
      // Forwards the Authorization header, cookies and query strings.
      originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    };
    const distribution = new Distribution(this, "Cdn", {
      defaultBehavior: apiBehavior,
      additionalBehaviors: { "/api/*": apiBehavior },
      priceClass: PriceClass.PRICE_CLASS_100,
    });
    new CfnOutput(this, "ApiUrl", { value: `https://${distribution.distributionDomainName}` });

    // Four alarms keeps within CloudWatch's free 10. The Lambda ones use the account-wide
    // metrics (one alarm each instead of one per function), so they also cover any other
    // Lambdas in this account and region.
    const alarmTopic = new Topic(this, "AlarmTopic");
    const alarmEmail = this.node.tryGetContext("alarmEmail");
    if (alarmEmail) alarmTopic.addSubscription(new EmailSubscription(alarmEmail));

    new MetricFilter(this, "FailedLoginsFilter", {
      logGroup: authFunction.logGroup,
      filterPattern: FilterPattern.stringValue("$.event", "=", "login_failed"),
      metricNamespace: "LedgerApi",
      metricName: "FailedLogins",
      metricValue: "1",
    });
    const fiveMinutes = Duration.minutes(5);
    const alarms: [string, Metric, number][] = [
      ["Api5xx", new Metric({ namespace: "AWS/ApiGateway", metricName: "5xx", dimensionsMap: { ApiId: api.apiId } }), 1],
      ["LambdaErrors", new Metric({ namespace: "AWS/Lambda", metricName: "Errors" }), 1],
      ["LambdaThrottles", new Metric({ namespace: "AWS/Lambda", metricName: "Throttles" }), 1],
      // Lockout already stops guessing one account; this catches guessing across many.
      ["FailedLogins", new Metric({ namespace: "LedgerApi", metricName: "FailedLogins" }), 20],
    ];
    for (const [name, metric, threshold] of alarms) {
      new Alarm(this, `${name}Alarm`, {
        metric: metric.with({ statistic: "Sum", period: fiveMinutes }),
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new SnsAction(alarmTopic));
    }
  }
}
