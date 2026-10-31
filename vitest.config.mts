import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          // Synthesizing a stack would otherwise build the Python bundles with uv, which takes seconds per
          // stack; only test/unit/python-code.test.ts looks at them, and it turns bundling back on.
          env: { CDK_CONTEXT_JSON: JSON.stringify({ "aws:cdk:bundling-stacks": [] }) },
        },
      },
    ],
  },
});
