import { createPrivateKey } from "node:crypto";

function requireValue(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Required environment variable ${name} is not set`);
  return value;
}

function optionalValue(name) {
  return process.env[name] || undefined;
}

function verifyPair(signingKeyName, publicJwkName) {
  const signingKey = requireValue(signingKeyName);
  const publicJwk = requireValue(publicJwkName);
  let derived;
  let expected;
  try {
    derived = createPrivateKey(signingKey).export({ format: "jwk" });
    expected = JSON.parse(publicJwk);
  } catch {
    throw new Error(`${signingKeyName} or ${publicJwkName} is invalid`);
  }
  if (
    derived.kty !== "RSA" ||
    derived.n !== expected.n ||
    derived.e !== expected.e ||
    expected.kty !== "RSA" ||
    typeof expected.kid !== "string" ||
    !expected.kid ||
    expected.alg !== "RS256" ||
    expected.use !== "sig"
  ) {
    throw new Error(`${signingKeyName} does not match ${publicJwkName}`);
  }
  return expected.kid;
}

function main() {
  const currentKid = verifyPair("TELEMETRY_OIDC_SIGNING_KEY", "TELEMETRY_OIDC_PUBLIC_JWK");
  const previousSigningKey = optionalValue("TELEMETRY_OIDC_PREVIOUS_SIGNING_KEY");
  const previousPublicJwk = optionalValue("TELEMETRY_OIDC_PREVIOUS_PUBLIC_JWK");
  if (Boolean(previousSigningKey) !== Boolean(previousPublicJwk)) {
    throw new Error("TELEMETRY_OIDC_PREVIOUS_SIGNING_KEY and TELEMETRY_OIDC_PREVIOUS_PUBLIC_JWK must be set together");
  }
  if (!previousSigningKey) {
    process.stdout.write("Telemetry OIDC signing key matches configured public JWK\n");
    return;
  }

  const previousKid = verifyPair(
    "TELEMETRY_OIDC_PREVIOUS_SIGNING_KEY",
    "TELEMETRY_OIDC_PREVIOUS_PUBLIC_JWK",
  );
  if (previousKid === currentKid) {
    throw new Error("Telemetry OIDC signing keys must use different kids");
  }
  process.stdout.write("Telemetry OIDC signing keys match configured public JWKs\n");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not verify telemetry OIDC signing keys");
  process.exitCode = 1;
}
