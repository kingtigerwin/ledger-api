import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import cdkJson from "../../cdk.json";
import { defineStacks } from "../../lib/app";
import deployed from "../fixtures/deployed-resources.json";

// What CloudFormation held for each stack before the move back to TypeScript (python-final). A resource
// whose logical ID changes is replaced: for a table, that's a new, empty table. Email subscriptions are
// left out, since their IDs hold the address; CDK derives them from it the same way in every language.
describe("given the app as cdk.json configures it", () => {
  let app: App;

  beforeAll(() => {
    app = new App({ context: { ...cdkJson.context, adminEmail: "admin@example.com" } });
    defineStacks(app, { account: "111111111111" });
  });

  const resourcesOf = (stackName: string) => {
    const stack = app.node.findChild(stackName) as Stack;
    const resources = Template.fromStack(stack).toJSON().Resources as Record<string, { Type: string }>;
    return Object.fromEntries(Object.entries(resources).map(([id, resource]) => [id, resource.Type]));
  };

  it.each(Object.entries(deployed))("keeps every deployed resource of %s, so none is replaced", (stackName, expected) => {
    const resources = resourcesOf(stackName);
    const missing = Object.entries(expected).filter(([id, type]) => resources[id] !== type);
    expect(missing).toEqual([]);
  });
});
