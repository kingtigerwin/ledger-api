import { App } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { LedgerStack } from "../../lib/ledger-stack";

describe("LedgerStack", () => {
  it("synthesizes", () => {
    const stack = new LedgerStack(new App(), "LedgerApi", { env: { region: "ap-southeast-2" } });
    expect(stack.region).toBe("ap-southeast-2");
  });
});
