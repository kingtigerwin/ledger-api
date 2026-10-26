import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: "unit", include: ["test/unit/**/*.test.ts"] },
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
