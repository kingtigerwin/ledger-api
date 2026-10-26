import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { createAuthHandler } from "./handler";

const ssm = new SSMClient({});

// Read once per cold start; the parameter itself is created by the stack (Stage 3).
const ready = ssm
  .send(new GetParameterCommand({ Name: process.env.SIGNING_SECRET_PARAM, WithDecryption: true }))
  .then(({ Parameter }) =>
    createAuthHandler({
      tableName: process.env.USERS_TABLE!,
      signingSecret: Parameter!.Value!,
      now: () => new Date(),
    }),
  );

export const handler = async (event: APIGatewayProxyEventV2) => (await ready)(event);
