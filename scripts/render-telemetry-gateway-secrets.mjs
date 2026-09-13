function requireValue(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Required environment variable ${name} is not set`);
  return value;
}

function optionalValue(name) {
  return process.env[name] || undefined;
}

function previousSigningKid() {
  const source = optionalValue("TELEMETRY_OIDC_PREVIOUS_PUBLIC_JWK");
  if (!source) return undefined;
  let jwk;
  try {
    jwk = JSON.parse(source);
  } catch {
    throw new Error("TELEMETRY_OIDC_PREVIOUS_PUBLIC_JWK is invalid");
  }
  if (!jwk || typeof jwk !== "object" || Array.isArray(jwk) || typeof jwk.kid !== "string" || !jwk.kid) {
    throw new Error("TELEMETRY_OIDC_PREVIOUS_PUBLIC_JWK does not contain a signing kid");
  }
  return jwk.kid;
}

function signingKeys() {
  const current = {
    kid: requireValue("TELEMETRY_OIDC_SIGNING_KID"),
    privateKeyPem: requireValue("TELEMETRY_OIDC_SIGNING_KEY"),
  };
  const previousKey = optionalValue("TELEMETRY_OIDC_PREVIOUS_SIGNING_KEY");
  const previousKid = previousSigningKid();
  if (Boolean(previousKey) !== Boolean(previousKid)) {
    throw new Error("TELEMETRY_OIDC_PREVIOUS_SIGNING_KEY and TELEMETRY_OIDC_PREVIOUS_PUBLIC_JWK must be set together");
  }
  if (!previousKey) return [current];
  if (previousKid === current.kid) throw new Error("Telemetry OIDC signing keys must use different kids");
  return [current, { kid: previousKid, privateKeyPem: previousKey }];
}

function ingestBearers() {
  const current = requireValue("TELEMETRY_GATEWAY_INGEST_BEARER");
  const previous = optionalValue("TELEMETRY_GATEWAY_PREVIOUS_INGEST_BEARER");
  if (!previous) return [current];
  if (previous === current) throw new Error("Telemetry gateway ingest bearers must differ");
  return [current, previous];
}

function main() {
  const [kind] = process.argv.slice(2);
  if (kind === "signing-keys") {
    process.stdout.write(JSON.stringify(signingKeys()));
    return;
  }
  if (kind === "ingest-bearers") {
    process.stdout.write(JSON.stringify(ingestBearers()));
    return;
  }
  throw new Error("Usage: node scripts/render-telemetry-gateway-secrets.mjs signing-keys|ingest-bearers");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not render telemetry gateway secrets");
  process.exitCode = 1;
}
