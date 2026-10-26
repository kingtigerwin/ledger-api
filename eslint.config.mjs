import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["cdk.out/", "node_modules/", "coverage/"] },
  js.configs.recommended,
  tseslint.configs.recommended,
);
