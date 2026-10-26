import type { ParameterStore } from "../../src/bootstrap/parameters";

/** In-memory stand-in for SSM Parameter Store; SSM is an external system DynamoDB Local can't replace. */
export function fakeParameterStore(): ParameterStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    async get(name) {
      return values.get(name);
    },
    async createSecure(name, value) {
      if (values.has(name)) throw new Error(`Parameter ${name} already exists`);
      values.set(name, value);
    },
  };
}
