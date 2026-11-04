import { GetParameterCommand, ParameterNotFound, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

export interface ParameterStore {
  get(name: string): Promise<string | undefined>;
  /** Creates an encrypted parameter; fails if it already exists, so a secret is never overwritten. */
  createSecure(name: string, value: string): Promise<void>;
}

export function ssmParameterStore(ssm = new SSMClient({})): ParameterStore {
  return {
    async get(name) {
      try {
        const { Parameter } = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
        return Parameter?.Value;
      } catch (err) {
        if (err instanceof ParameterNotFound) return undefined;
        throw err;
      }
    },
    async createSecure(name, value) {
      // Standard tier and the AWS-managed aws/ssm key keep this free.
      await ssm.send(new PutParameterCommand({ Name: name, Value: value, Type: "SecureString", Overwrite: false }));
    },
  };
}
