import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { exchangeCode, type GoogleSignIn, loadClientSecret } from "./google";
import { createAuthHandler } from "./handler";
import { loadSigningSecret } from "./signing-secret";

/** Google sign-in, if the stack configured it. Its client secret is read on first use. */
function google(): GoogleSignIn | undefined {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !redirectUri) return undefined;
  let clientSecret: Promise<string> | undefined;
  return {
    clientId,
    redirectUri,
    exchangeCode: async (code, codeVerifier) => {
      clientSecret ??= loadClientSecret().catch((err) => {
        clientSecret = undefined; // try SSM again on the next sign-in
        throw err;
      });
      return exchangeCode({ code, codeVerifier, clientId, clientSecret: await clientSecret, redirectUri });
    },
  };
}

const ready = loadSigningSecret().then((signingSecret) =>
  createAuthHandler({ tableName: process.env.USERS_TABLE!, signingSecret, now: () => new Date(), google: google() }),
);

export const handler = async (event: APIGatewayProxyEventV2) => (await ready)(event);
