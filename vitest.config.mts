import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          // Synthesizing a stack would otherwise bundle every Lambda with esbuild, which takes seconds
          // per stack (enough to time out on CI) and no unit test looks at the bundled code.
          env: { CDK_CONTEXT_JSON: JSON.stringify({ "aws:cdk:bundling-stacks": [] }) },
        },
      },
    ],
  },
});
