interface Env {
  DEPLOYMENT_ENVIRONMENT: "production" | "ppe";
  ISSUER_URL: string;
  OIDC_PUBLIC_JWK: string;
  OIDC_PREVIOUS_PUBLIC_JWK?: string;
  OIDC_SIGNING_KID: string;
}

interface PublicJwk {
  kty: "RSA";
  kid: string;
  n: string;
  e: string;
  alg: "RS256";
  use: "sig";
}

interface IssuerConfiguration {
  environment: "production" | "ppe";
  issuerUrl: string;
  signingKid: string;
  jwkSources: string;
  jwks: PublicJwk[];
}

let cachedConfiguration: IssuerConfiguration | undefined;

function parsePublicJwk(
  source: string,
  environment: "production" | "ppe",
  expectedKid?: string,
): PublicJwk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("OIDC public JWK is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OIDC public JWK is not an object");
  }
  const jwk = parsed as Record<string, unknown>;
  if (
    jwk.kty !== "RSA" ||
    typeof jwk.kid !== "string" ||
    !jwk.kid.startsWith(`${environment}-`) ||
    (expectedKid !== undefined && jwk.kid !== expectedKid) ||
    jwk.alg !== "RS256" ||
    jwk.use !== "sig" ||
    typeof jwk.n !== "string" ||
    jwk.n.length < 256 ||
    typeof jwk.e !== "string" ||
    jwk.e.length === 0
  ) {
    throw new Error("OIDC public JWK does not match the configured RS256 signing contract");
  }
  return {
    kty: "RSA",
    kid: jwk.kid,
    n: jwk.n,
    e: jwk.e,
    alg: "RS256",
    use: "sig",
  };
}

function configuration(env: Env): IssuerConfiguration {
  const previousJwkSource = env.OIDC_PREVIOUS_PUBLIC_JWK?.trim() || undefined;
  const jwkSources = `${env.OIDC_PUBLIC_JWK}\u0000${previousJwkSource ?? ""}`;
  if (
    cachedConfiguration?.environment === env.DEPLOYMENT_ENVIRONMENT &&
    cachedConfiguration.issuerUrl === env.ISSUER_URL &&
    cachedConfiguration.signingKid === env.OIDC_SIGNING_KID &&
    cachedConfiguration.jwkSources === jwkSources
  ) return cachedConfiguration;

  if (env.DEPLOYMENT_ENVIRONMENT !== "production" && env.DEPLOYMENT_ENVIRONMENT !== "ppe") {
    throw new Error("Invalid deployment environment");
  }

  let issuer: URL;
  try {
    issuer = new URL(env.ISSUER_URL);
  } catch {
    throw new Error("Invalid OIDC issuer URL");
  }
  if (
    issuer.protocol !== "https:" ||
    issuer.origin !== env.ISSUER_URL ||
    !issuer.hostname.startsWith("watch-pr-oidc-issuer.") ||
    !issuer.hostname.endsWith(".workers.dev")
  ) {
    throw new Error("OIDC issuer URL must be this Worker's workers.dev HTTPS origin");
  }

  const currentJwk = parsePublicJwk(
    env.OIDC_PUBLIC_JWK,
    env.DEPLOYMENT_ENVIRONMENT,
    env.OIDC_SIGNING_KID,
  );
  const jwks = [currentJwk];
  if (previousJwkSource) {
    const previousJwk = parsePublicJwk(previousJwkSource, env.DEPLOYMENT_ENVIRONMENT);
    if (previousJwk.kid === currentJwk.kid) {
      throw new Error("OIDC previous public JWK must use a different signing kid");
    }
    jwks.push(previousJwk);
  }

  cachedConfiguration = {
    environment: env.DEPLOYMENT_ENVIRONMENT,
    issuerUrl: issuer.origin,
    signingKid: env.OIDC_SIGNING_KID,
    jwkSources,
    jwks,
  };
  return cachedConfiguration;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const selected = configuration(env);
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/.well-known/openid-configuration") {
      return Response.json(
        {
          issuer: selected.issuerUrl,
          jwks_uri: `${selected.issuerUrl}/.well-known/jwks.json`,
          response_types_supported: ["id_token"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        },
        { headers: { "Cache-Control": "public, max-age=60" } },
      );
    }
    if (request.method === "GET" && path === "/.well-known/jwks.json") {
      return Response.json(
        { keys: selected.jwks },
        { headers: { "Cache-Control": "public, max-age=60" } },
      );
    }
    return new Response("Not found", { status: 404 });
  },
};
