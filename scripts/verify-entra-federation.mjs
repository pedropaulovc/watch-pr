import { createPrivateKey, createSign, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const TOKEN_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 5_000;
const MAX_ATTEMPTS = 18;

function requireValue(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Required environment variable ${name} is not set`);
  return value;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

export function signAssertion({ issuer, subject, kid, privateKeyPem }) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = [
    base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid })),
    base64url(JSON.stringify({
      iss: issuer,
      sub: subject,
      aud: "api://AzureADTokenExchange",
      iat: now,
      nbf: now - 30,
      exp: now + 300,
      jti: randomUUID(),
    })),
  ].join(".");
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(createPrivateKey(privateKeyPem)).toString("base64url")}`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeErrorMessage(error) {
  if (!(error instanceof Error) || !error.message) return "unknown error";
  return error.message.replace(/[\r\n]+/gu, " ").slice(0, 200);
}

function entraErrorCode(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const error = payload.error;
  if (typeof error !== "string" || !/^[a-z0-9_-]{1,64}$/iu.test(error)) return undefined;
  return error;
}

export async function exchangeToken(config) {
  let assertion;
  try {
    assertion = signAssertion(config);
  } catch (error) {
    return {
      accepted: false,
      retry: false,
      failure: `Could not sign the federation assertion: ${safeErrorMessage(error)}`,
    };
  }
  const body = new URLSearchParams({
    client_id: config.clientId,
    grant_type: "client_credentials",
    scope: "https://monitor.azure.com/.default",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
  });
  let response;
  try {
    response = await fetch(`https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      accepted: false,
      retry: true,
      failure: `Entra token request failed: ${safeErrorMessage(error)}`,
    };
  }
  const payload = await response.json().catch(() => undefined);
  if (response.ok && typeof payload?.access_token === "string") return { accepted: true };
  const errorCode = entraErrorCode(payload);
  return {
    accepted: false,
    retry: true,
    failure: `Entra token request returned HTTP ${response.status}${errorCode ? ` (${errorCode})` : ""}`,
  };
}

export async function verifyEntraFederation(config) {
  let lastFailure = "unknown error";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = await exchangeToken(config);
    if (result.accepted) return;
    lastFailure = result.failure;
    if (!result.retry) break;
    if (attempt < MAX_ATTEMPTS) await delay(RETRY_DELAY_MS);
  }
  throw new Error(`Entra did not accept the configured telemetry federation assertion before the rotation deadline: ${lastFailure}`);
}

async function main() {
  const config = {
    tenantId: requireValue("TELEMETRY_AZURE_TENANT_ID"),
    clientId: requireValue("TELEMETRY_AZURE_APP_CLIENT_ID"),
    issuer: requireValue("TELEMETRY_OIDC_ISSUER_URL"),
    subject: "cf-worker:watch-pr-telemetry-gateway",
    kid: requireValue("TELEMETRY_OIDC_SIGNING_KID"),
    privateKeyPem: requireValue("TELEMETRY_OIDC_SIGNING_KEY"),
  };
  await verifyEntraFederation(config);
  process.stdout.write("Entra accepted the configured telemetry federation assertion\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Could not verify telemetry Entra federation");
    process.exitCode = 1;
  });
}

