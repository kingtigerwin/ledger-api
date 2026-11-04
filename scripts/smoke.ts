// Post-deploy smoke test against the live API. Usage:
//   API_URL=https://dxxxx.cloudfront.net SMOKE_TEST_PASSWORD=... npm run smoke
// Reuses one user, `smoke-test`; the admin approves it on the first run. The transactions it creates are
// deleted again. The steps are in smoke-run.ts.
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { ADMIN_PASSWORD_PARAM } from "../src/config";
import { run, type Send, SmokeFailedError } from "./smoke-run";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new SmokeFailedError(`Set ${name}`);
  return value;
}

// Redirects are answers too: the Google step checks for one.
const httpSend: Send = async (method, url, headers, body) => {
  const res = await fetch(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  return { status: res.status, body: await res.text() };
};

async function adminPassword(): Promise<string> {
  const res = await new SSMClient({}).send(new GetParameterCommand({ Name: ADMIN_PASSWORD_PARAM, WithDecryption: true }));
  return res.Parameter?.Value ?? "";
}

run({
  baseUrl: required("API_URL"),
  send: httpSend,
  smokePassword: required("SMOKE_TEST_PASSWORD"),
  adminPassword,
  today: new Date().toISOString().slice(0, 10),
}).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
