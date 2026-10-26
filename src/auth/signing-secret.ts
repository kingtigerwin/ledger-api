import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

/** Reads the JWT signing secret from SSM; call once per cold start. The parameter is created by the stack (Stage 3). */
export async function loadSigningSecret(): Promise<string> {
  const { Parameter } = await new SSMClient({}).send(
    new GetParameterCommand({ Name: process.env.SIGNING_SECRET_PARAM, WithDecryption: true }),
  );
  return Parameter!.Value!;
}
