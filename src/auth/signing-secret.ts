import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { SIGNING_SECRET_PARAM } from "../config";

/** Reads the JWT signing secret from SSM; call once per cold start. The bootstrap custom resource creates it. */
export async function loadSigningSecret(): Promise<string> {
  const { Parameter } = await new SSMClient({}).send(
    new GetParameterCommand({ Name: SIGNING_SECRET_PARAM, WithDecryption: true }),
  );
  return Parameter!.Value!;
}
