import { App } from "aws-cdk-lib";
import { defineStacks } from "../lib/app";

const app = new App();
defineStacks(app, { account: process.env.CDK_DEFAULT_ACCOUNT });
