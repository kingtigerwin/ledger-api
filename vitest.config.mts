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
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          // Runs against DynamoDB Local (`npm run db:up`).
          env: {
            DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000",
            AWS_REGION: "ap-southeast-2",
            AWS_ACCESS_KEY_ID: "local",
            AWS_SECRET_ACCESS_KEY: "local",
          },
        },
      },
    ],
  },
});
