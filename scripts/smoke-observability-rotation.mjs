import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// All credentials below are deliberately public fixtures. Never read process.env:
// this smoke must not send an operator's account token or ingest bearer anywhere.
const CURRENT = "smoke-fixture-current";
const PREVIOUS = "smoke-fixture-previous";
const ORIGIN = "https://gateway.example.test";
const API_ORIGIN = "https://api.cloudflare.com";
const ENDPOINT = "/client/v4/accounts/smoke-fixture-account/workers/observability/destinations";
const MAX_BYTES = 1024 * 1024;
const SOURCE = {
  CLOUDFLARE_ACCOUNT_ID: "smoke-fixture-account",
  CLOUDFLARE_API_TOKEN: "smoke-fixture-api-token",
  TELEMETRY_GATEWAY_INGEST_BEARER: CURRENT,
  TELEMETRY_GATEWAY_PREVIOUS_INGEST_BEARER: PREVIOUS,
  TELEMETRY_GATEWAY_ORIGIN: ORIGIN,
};
const TARGETS = [
  { name: "watch-pr-azure-logs", dataset: "opentelemetry-logs", path: "/v1/logs" },
  { name: "watch-pr-azure-traces", dataset: "opentelemetry-traces", path: "/v1/traces" },
];

function redactedDestinations() {
  return TARGETS.map((target) => ({
    name: target.name,
    slug: `${target.name}-slug`,
    enabled: true,
    configuration: {
      type: "logpush",
      url: `${ORIGIN}${target.path}`,
      logpushDataset: target.dataset,
      headers: { Authorization: null },
    },
  }));
}

function bearerLabel(authorization) {
  if (authorization === `Bearer ${CURRENT}`) return "current";
  if (authorization === `Bearer ${PREVIOUS}`) return "previous";
  return "invalid";
}

function json(response, result) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ success: true, result }));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function withSandbox(configure, { destinations = redactedDestinations(), accepted = [CURRENT] }, exercise) {
  const state = {
    destinations: structuredClone(destinations),
    accepted: new Set(accepted),
    events: [],
    probes: [],
    writes: [],
    requests: [],
    errors: [],
  };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname === "/v1/logs" || url.pathname === "/v1/traces") {
        assert.equal(request.method, "POST");
        assert.equal(request.headers["content-type"], "application/json");
        const bearer = bearerLabel(request.headers.authorization);
        const event = { kind: "probe", path: url.pathname, bearer };
        state.events.push(event);
        state.probes.push(event);
        // Faithful to the actual gateway's auth-before-size behavior, with a
        // configured signing key assumed: unauthorized input is acknowledged;
        // authorized input one byte over the compressed bound reaches 413,
        // before JSON parsing, Entra, or Azure. The actual Worker handler is
        // independently pinned in test/telemetry-gateway.test.ts.
        const authorized = [...state.accepted].some((value) => request.headers.authorization === `Bearer ${value}`);
        if (!authorized) {
          event.status = 200;
          request.resume();
          response.writeHead(200);
          response.end("OK");
          return;
        }
        let bytes = 0;
        for await (const chunk of request) bytes += chunk.length;
        event.bytes = bytes;
        event.status = bytes > MAX_BYTES ? 413 : 200;
        response.writeHead(event.status);
        response.end();
        return;
      }

      assert.equal(request.headers.authorization, `Bearer ${SOURCE.CLOUDFLARE_API_TOKEN}`);
      if (request.method === "GET" && url.pathname === ENDPOINT) {
        assert.equal(url.searchParams.get("perPage"), "50");
        const page = Number(url.searchParams.get("page"));
        assert.ok(Number.isInteger(page) && page > 0);
        state.events.push({ kind: "list", page });
        const entries = structuredClone(state.destinations);
        for (const entry of entries) entry.configuration.headers = { Authorization: null };
        json(response, entries.slice((page - 1) * 50, page * 50));
        return;
      }

      const payload = await readJson(request);
      assert.equal(payload.enabled, true);
      assert.equal(payload.configuration.type, "logpush");
      const bearer = bearerLabel(payload.configuration.headers.Authorization);
      assert.notEqual(bearer, "invalid");
      const event = { kind: "write", method: request.method, bearer };
      if (request.method === "PATCH" && url.pathname.startsWith(`${ENDPOINT}/`)) {
        assert.equal(Object.hasOwn(payload.configuration, "logpushDataset"), false);
        const slug = decodeURIComponent(url.pathname.slice(ENDPOINT.length + 1));
        const entry = state.destinations.find((destination) => destination.slug === slug);
        assert.ok(entry, "PATCH must address an existing destination slug");
        entry.enabled = payload.enabled;
        entry.configuration = { ...entry.configuration, ...payload.configuration };
      } else {
        assert.equal(request.method, "POST");
        assert.equal(url.pathname, ENDPOINT);
        const target = TARGETS.find((candidate) => candidate.name === payload.name);
        assert.ok(target);
        assert.equal(payload.configuration.logpushDataset, target.dataset);
        state.destinations.push({ ...payload, slug: `${payload.name}-created` });
      }
      state.events.push(event);
      state.writes.push(event);
      json(response, {});
    })().catch((error) => {
      state.errors.push(error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const localOrigin = `http://127.0.0.1:${address.port}`;
  const realFetch = globalThis.fetch;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    assert.ok(url.origin === API_ORIGIN || url.origin === ORIGIN, "only fixture logical origins may be routed locally");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    if (url.origin === ORIGIN) {
      assert.ok(init.body instanceof Uint8Array);
      assert.equal(init.body.byteLength, MAX_BYTES + 1);
    }
    state.requests.push({ origin: url.origin, path: url.pathname, method: init.method ?? "GET" });
    // Localhost is transport only. The source origin and all saved destination
    // URLs remain HTTPS, exercising the production origin/destination guards.
    return realFetch(`${localOrigin}${url.pathname}${url.search}`, init);
  };
  state.run = (command = "configure") => configure({ command, source: SOURCE, fetchImpl, write: () => {} });
  try {
    await exercise(state);
    assert.deepEqual(state.errors, [], "local HTTP responder must not hide a failed assertion");
  } finally {
    server.closeAllConnections();
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
}

function assertProof(events, bearer, status) {
  for (const path of ["/v1/logs", "/v1/traces"]) {
    assert.ok(events.some((event) => event.kind === "probe" && event.path === path && event.bearer === "invalid" && event.status === 200), `invalid control must return 200 for ${path}`);
    assert.ok(events.some((event) => event.kind === "probe" && event.path === path && event.bearer === bearer && event.status === status), `${bearer} must return ${status} for ${path}`);
  }
}

function assertWriteReadbackProof(events, bearer) {
  const firstWrite = events.findIndex((event) => event.kind === "write");
  const lastWrite = events.findLastIndex((event) => event.kind === "write");
  assert.ok(firstWrite >= 0);
  assertProof(events.slice(0, firstWrite), bearer, 413);
  const readback = events.findIndex((event, index) => index > lastWrite && event.kind === "list");
  assert.ok(readback > lastWrite, "readback must follow all writes");
  assertProof(events.slice(readback + 1), bearer, 413);
}

async function main() {
  if (process.argv.length > 3) {
    console.error("Usage: node scripts/smoke-observability-rotation.mjs [module-path]");
    process.exitCode = 2;
    return;
  }
  const moduleUrl = process.argv[2]
    ? pathToFileURL(resolve(process.argv[2]))
    : new URL("./configure-observability.mjs", import.meta.url);
  const implementation = await import(moduleUrl.href);
  if (typeof implementation.configureObservability !== "function") {
    if (typeof implementation.verifyExistingBearerRotation === "function") {
      const readable = redactedDestinations();
      for (const entry of readable) entry.configuration.headers.Authorization = `Bearer ${CURRENT}`;
      try {
        await implementation.verifyExistingBearerRotation(readable, [CURRENT, PREVIOUS]);
      } catch {
        console.error("UNSUPPORTED_FEATURE: legacy guard rejects the readable control, so null-redaction regression evidence is inconclusive");
        process.exitCode = 2;
        return;
      }
      try {
        await implementation.verifyExistingBearerRotation(redactedDestinations(), [CURRENT, PREVIOUS]);
      } catch {
        console.error("HISTORICAL_REDACTED_AUTH_REJECTED: legacy guard rejects otherwise-valid Authorization:null destinations; orchestration is unavailable in this revision");
        process.exitCode = 1;
        return;
      }
    }
    console.error("UNSUPPORTED_FEATURE: selected module does not export configureObservability; no targeted orchestration regression was exercised");
    process.exitCode = 2;
    return;
  }
  const configure = implementation.configureObservability;

  await withSandbox(configure, {}, async (state) => {
    await state.run();
    assert.equal(state.writes.length, 2);
    assert.ok(state.writes.every((write) => write.bearer === "current" && write.method === "PATCH"));
    assertWriteReadbackProof(state.events, "current");
    assert.ok(state.probes.filter((probe) => probe.status === 413).every((probe) => probe.bytes === MAX_BYTES + 1));
  });
  console.log("PASS redacted normal deploy: current proven before PATCH and after readback");

  await withSandbox(configure, { accepted: [PREVIOUS] }, async (state) => {
    await state.run("prepare");
    assert.equal(state.writes.length, 2);
    assert.ok(state.writes.every((write) => write.bearer === "previous" && write.method === "PATCH"));
    const firstWrite = state.events.findIndex((event) => event.kind === "write");
    assertProof(state.events.slice(0, firstWrite), "current", 200);
    assertWriteReadbackProof(state.events, "previous");
    const firstPrevious = state.probes.findIndex((probe) => probe.bearer === "previous");
    const lastCurrent = state.probes.findLastIndex((probe) => probe.bearer === "current");
    assert.ok(firstPrevious > lastCurrent, "previous fallback must follow current rejection");

    state.events.push({ kind: "overlap" });
    const configuredAt = state.events.length;
    state.accepted.add(CURRENT);
    await state.run();
    assert.equal(state.writes.length, 4);
    assert.ok(state.writes.slice(2).every((write) => write.bearer === "current"));
    assertWriteReadbackProof(state.events.slice(configuredAt), "current");
    assert.ok(state.destinations.every((entry) => entry.configuration.headers.Authorization === `Bearer ${CURRENT}`));
  });
  console.log("PASS true rotation: current200 / previous413 stages previous before overlap, then configures current");

  await withSandbox(configure, { accepted: [] }, async (state) => {
    await assert.rejects(state.run("prepare"));
    assert.equal(state.writes.length, 0);
    assertProof(state.events, "current", 200);
    assertProof(state.events, "previous", 200);
  });
  console.log("PASS neither bearer accepted: zero mutations");

  await withSandbox(configure, { destinations: [], accepted: [] }, async (state) => {
    await state.run("prepare");
    assert.equal(state.probes.length, 0);
    assert.equal(state.writes.length, 0);
    state.accepted.add(CURRENT);
    await state.run();
    assert.equal(state.writes.length, 2);
    assert.ok(state.writes.every((write) => write.method === "POST" && write.bearer === "current"));
    assertWriteReadbackProof(state.events, "current");
  });
  console.log("PASS bootstrap: no old-gateway probes during prepare; current proven before creating destinations");
  console.log("LIMIT: local HTTP discriminator and orchestration only; run telemetry-gateway.test.ts for the actual Worker handler. No Cloudflare delivery or Azure forwarding proof.");
}

main().catch((error) => {
  console.error(`SMOKE_FAILED: ${error instanceof Error ? error.message : "unknown failure"}`);
  process.exitCode = 1;
});
