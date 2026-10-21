import { afterEach, describe, expect, it, vi } from "vitest";
import { configureObservability, destinationPayload } from "../scripts/configure-observability.mjs";

const CURRENT = "fixture-current-bearer";
const PREVIOUS = "fixture-previous-bearer";
const OTHER = "fixture-unexpected-bearer";
const ORIGIN = "https://gateway.example.test";
const ENDPOINT = "/client/v4/accounts/fixture-account/workers/observability/destinations";
const SOURCE = {
  CLOUDFLARE_ACCOUNT_ID: "fixture-account",
  CLOUDFLARE_API_TOKEN: "fixture-api-token",
  TELEMETRY_GATEWAY_INGEST_BEARER: CURRENT,
  TELEMETRY_GATEWAY_PREVIOUS_INGEST_BEARER: PREVIOUS,
  TELEMETRY_GATEWAY_ORIGIN: ORIGIN,
};
const TARGETS = [
  { name: "watch-pr-azure-logs", dataset: "opentelemetry-logs", path: "/v1/logs" },
  { name: "watch-pr-azure-traces", dataset: "opentelemetry-traces", path: "/v1/traces" },
];

function destination(target, authorization = null) {
  return {
    name: target.name,
    slug: `${target.name}-slug`,
    enabled: true,
    configuration: {
      type: "logpush",
      url: `${ORIGIN}${target.path}`,
      logpushDataset: target.dataset,
      headers: { Authorization: authorization },
    },
  };
}

function existing() {
  return TARGETS.map((target) => destination(target));
}

function fixture({
  destinations = existing(),
  accepted = [CURRENT],
  exposeHeaders = false,
  listTransform = (entries) => entries,
  apiResponse,
  gatewayStatus,
} = {}) {
  let stored = structuredClone(destinations);
  let listing = 0;
  const acceptedBearers = new Set(accepted);
  const events = [];
  const writes = [];
  const probes = [];
  const output = [];
  const api = [];

  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = new Headers(init.headers);
    const event = { url, init, headers, method: init.method ?? "GET" };
    if (url.origin === "https://api.cloudflare.com") {
      event.kind = "api";
      api.push(event);
      events.push(event);
      const overridden = await apiResponse?.(event);
      if (overridden) return overridden;
      if (event.method === "GET" && url.pathname === ENDPOINT) {
        const page = Number(url.searchParams.get("page"));
        expect(url.searchParams.get("perPage")).toBe("50");
        expect(Number.isInteger(page) && page > 0).toBe(true);
        if (page === 1) listing += 1;
        event.listing = listing;
        let entries = structuredClone(stored);
        if (!exposeHeaders) {
          for (const entry of entries) {
            if (entry?.configuration?.headers && Object.hasOwn(entry.configuration.headers, "Authorization")) {
              entry.configuration.headers.Authorization = null;
            }
          }
        }
        entries = listTransform(entries, listing);
        return Response.json({
          success: true,
          result: Array.isArray(entries) ? entries.slice((page - 1) * 50, page * 50) : entries,
        });
      }
      const payload = JSON.parse(init.body);
      if (event.method === "PATCH" && url.pathname.startsWith(`${ENDPOINT}/`)) {
        const slug = decodeURIComponent(url.pathname.slice(ENDPOINT.length + 1));
        const index = stored.findIndex((entry) => entry.slug === slug);
        expect(index).toBeGreaterThanOrEqual(0);
        stored[index] = {
          ...stored[index],
          ...payload,
          configuration: { ...stored[index].configuration, ...payload.configuration },
        };
      } else if (event.method === "POST" && url.pathname === ENDPOINT) {
        stored.push({ ...payload, slug: `${payload.name}-created` });
      } else {
        throw new Error("Unexpected fixture Cloudflare request");
      }
      event.payload = payload;
      writes.push(event);
      return Response.json({ success: true, result: {} });
    }
    if (url.origin !== ORIGIN) throw new Error("Unexpected fixture gateway origin");
    event.kind = "gateway";
    event.bearer = headers.get("Authorization")?.replace(/^Bearer /u, "");
    event.status = gatewayStatus
      ? await gatewayStatus(event)
      : acceptedBearers.has(event.bearer) ? 413 : 200;
    probes.push(event);
    events.push(event);
    return new Response(null, { status: event.status });
  };

  return {
    acceptedBearers, api, events, output, probes, writes,
    run(command = "configure", source = SOURCE) {
      return configureObservability({ command, source, fetchImpl, write: (text) => output.push(text) });
    },
    stored: () => stored,
  };
}

function expectNoSideEffects(state) {
  expect(state.probes).toHaveLength(0);
  expect(state.writes).toHaveLength(0);
}

function expectProbeProtocol(state) {
  for (const probe of state.probes) {
    expect(probe.method).toBe("POST");
    expect(probe.init.body).toBeInstanceOf(Uint8Array);
    expect(probe.init.body.byteLength).toBe(1024 * 1024 + 1);
    expect(probe.headers.get("Content-Type")).toBe("application/json");
    expect(probe.init.redirect).toBe("error");
    expect(probe.init.signal).toBeInstanceOf(AbortSignal);
    expect(["/v1/logs", "/v1/traces"]).toContain(probe.url.pathname);
  }
  const controls = state.probes.filter((probe) => ![CURRENT, PREVIOUS].includes(probe.bearer));
  expect(controls.length).toBeGreaterThanOrEqual(2);
  for (const control of controls) {
    expect(control.bearer).toBeTruthy();
    expect(control.status).toBe(200);
  }
  expect(new Set(controls.map((control) => control.url.pathname))).toEqual(new Set(["/v1/logs", "/v1/traces"]));
}

function expectWrittenBearer(state, bearer, method = "PATCH") {
  expect(state.writes).toHaveLength(2);
  for (const write of state.writes) {
    expect(write.method).toBe(method);
    expect(write.payload.configuration.headers).toEqual({ Authorization: `Bearer ${bearer}` });
    expect(write.payload.enabled).toBe(true);
    if (method === "PATCH") expect(write.payload.configuration).not.toHaveProperty("logpushDataset");
  }
}

afterEach(() => vi.restoreAllMocks());

describe("observability destination orchestration", () => {
  it("configures initially redacted destinations only after proving current, then reads back and proves it again", async () => {
    const budgets = new WeakMap();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const signal = timeout(milliseconds);
      budgets.set(signal, milliseconds);
      return signal;
    });
    const state = fixture();

    await state.run();

    expectWrittenBearer(state, CURRENT);
    expectProbeProtocol(state);
    expect(state.api.filter((event) => event.method === "GET")).toHaveLength(2);
    const firstWrite = state.events.indexOf(state.writes[0]);
    const lastWrite = state.events.indexOf(state.writes.at(-1));
    const readback = state.events.findIndex((event) => event.listing === 2);
    for (const path of ["/v1/logs", "/v1/traces"]) {
      expect(state.events.slice(0, firstWrite).some((event) => event.bearer === CURRENT && event.url.pathname === path && event.status === 413)).toBe(true);
      expect(state.events.slice(readback + 1).some((event) => event.bearer === CURRENT && event.url.pathname === path && event.status === 413)).toBe(true);
    }
    expect(readback).toBeGreaterThan(lastWrite);
    expect(state.probes.some((probe) => probe.bearer === PREVIOUS)).toBe(false);
    for (const event of state.events) {
      expect(event.init.redirect).toBe("error");
      expect(budgets.get(event.init.signal)).toBe(event.kind === "api" ? 30_000 : 10_000);
    }
    const controls = state.probes.filter((probe) => ![CURRENT, PREVIOUS].includes(probe.bearer));
    expect(new Set(controls.map((probe) => probe.bearer)).size).toBe(1);
  });

  it("generates a fresh invalid bearer control for each invocation", async () => {
    const first = fixture();
    const second = fixture();
    await first.run();
    await second.run();
    const invalid = (state) => state.probes.find((probe) => ![CURRENT, PREVIOUS].includes(probe.bearer)).bearer;
    expect(invalid(first)).not.toBe(invalid(second));
  });

  it("stages the proven previous bearer before overlap, then configures current only after overlap", async () => {
    const state = fixture({ accepted: [PREVIOUS] });

    await state.run("prepare");

    expectWrittenBearer(state, PREVIOUS);
    expectProbeProtocol(state);
    const firstWrite = state.events.indexOf(state.writes[0]);
    const prewrite = state.events.slice(0, firstWrite);
    expect(prewrite.filter((event) => event.bearer === CURRENT).map((event) => event.status)).toEqual([200, 200]);
    expect(prewrite.filter((event) => event.bearer === PREVIOUS).map((event) => event.status)).toEqual([413, 413]);
    expect(prewrite.findIndex((event) => event.bearer === PREVIOUS)).toBeGreaterThan(prewrite.map((event) => event.bearer).lastIndexOf(CURRENT));
    const stagedReadback = state.events.findIndex((event) => event.listing === 2);
    expect(stagedReadback).toBeGreaterThan(state.events.indexOf(state.writes.at(-1)));
    expect(state.events.slice(stagedReadback + 1).filter((event) => event.bearer === PREVIOUS).map((event) => event.status)).toEqual([413, 413]);

    const overlapAt = state.events.length;
    state.acceptedBearers.add(CURRENT);
    await state.run();

    expect(state.writes).toHaveLength(4);
    for (const write of state.writes.slice(2)) {
      expect(state.events.indexOf(write)).toBeGreaterThanOrEqual(overlapAt);
      expect(write.payload.configuration.headers.Authorization).toBe(`Bearer ${CURRENT}`);
    }
    expect(state.stored().every((entry) => entry.configuration.headers.Authorization === `Bearer ${CURRENT}`)).toBe(true);
  });

  it("prepare uses current when accepted and never probes previous", async () => {
    const state = fixture();
    await state.run("prepare");
    expectWrittenBearer(state, CURRENT);
    expect(state.probes.some((probe) => probe.bearer === PREVIOUS)).toBe(false);
  });

  it("prepare patches only existing redacted destinations, leaving readable headers and missing targets alone", async () => {
    const state = fixture({
      destinations: [destination(TARGETS[0]), destination(TARGETS[1], `Bearer ${PREVIOUS}`)],
      exposeHeaders: true,
      accepted: [PREVIOUS],
    });
    await state.run("prepare");
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].method).toBe("PATCH");
    expect(state.writes[0].url.pathname).toBe(`${ENDPOINT}/${TARGETS[0].name}-slug`);
    expect(state.writes[0].payload.configuration.headers.Authorization).toBe(`Bearer ${PREVIOUS}`);

    const partial = fixture({ destinations: [destination(TARGETS[0])] });
    await partial.run("prepare");
    expect(partial.writes).toHaveLength(1);
    expect(partial.writes[0].method).toBe("PATCH");
  });

  it("bootstrap prepare does not contact an old gateway or mutate destinations", async () => {
    const state = fixture({ destinations: [] });
    await state.run("prepare");
    expectNoSideEffects(state);
    expect(state.api).toHaveLength(1);

    await state.run();
    expectWrittenBearer(state, CURRENT, "POST");
    expectProbeProtocol(state);
  });

  it("configure accepts readable current or redacted readback and enables disabled destinations", async () => {
    const destinations = existing();
    destinations[0].enabled = false;
    const state = fixture({ destinations, exposeHeaders: true });
    await state.run();
    expectWrittenBearer(state, CURRENT);
    expect(state.stored().every((entry) => entry.enabled)).toBe(true);
  });

  it("performs no mutations when neither current nor explicit previous is accepted", async () => {
    const state = fixture({ accepted: [] });
    await expect(state.run("prepare")).rejects.toThrow();
    expect(state.writes).toHaveLength(0);
    expect(state.probes.filter((probe) => probe.bearer === CURRENT).map((probe) => probe.status)).toEqual([200, 200]);
    expect(state.probes.filter((probe) => probe.bearer === PREVIOUS).map((probe) => probe.status)).toEqual([200, 200]);
  });

  it("configure never falls back to previous when current is rejected", async () => {
    const state = fixture({ accepted: [PREVIOUS] });
    await expect(state.run()).rejects.toThrow();
    expect(state.writes).toHaveLength(0);
    expect(state.probes.some((probe) => probe.bearer === PREVIOUS)).toBe(false);
  });

  it("does not invent a fallback bearer when none is explicitly configured", async () => {
    const state = fixture({ accepted: [] });
    const source = { ...SOURCE };
    delete source.TELEMETRY_GATEWAY_PREVIOUS_INGEST_BEARER;
    await expect(state.run("prepare", source)).rejects.toThrow();
    expect(state.writes).toHaveLength(0);
    expect(state.probes.filter((probe) => probe.bearer === CURRENT)).toHaveLength(2);
  });
});

describe("pre-mutation destination guards", () => {
  const malformedTargets = [
    ["configuration", (entry) => { entry.configuration = null; }],
    ["type", (entry) => { entry.configuration.type = "http"; }],
    ["dataset", (entry) => { entry.configuration.logpushDataset = "opentelemetry-logs"; }],
    ["empty slug", (entry) => { entry.slug = ""; }],
    ["whitespace slug", (entry) => { entry.slug = "  "; }],
    ["nonstring slug", (entry) => { entry.slug = 42; }],
    ["path traversal slug", (entry) => { entry.slug = "../other"; }],
    ["path separator slug", (entry) => { entry.slug = "other/slug"; }],
    ["encoded path slug", (entry) => { entry.slug = "other%2Fslug"; }],
    ["enabled", (entry) => { entry.enabled = "true"; }],
    ["missing headers", (entry) => { delete entry.configuration.headers; }],
    ["array headers", (entry) => { entry.configuration.headers = []; }],
    ["missing authorization", (entry) => { entry.configuration.headers = {}; }],
    ["malformed extra header", (entry) => { entry.configuration.headers.Extra = 42; }],
    ["duplicate case-insensitive authorization", (entry) => { entry.configuration.headers.authorization = null; }],
    ["empty authorization", (entry) => { entry.configuration.headers.Authorization = ""; }],
    ["empty bearer", (entry) => { entry.configuration.headers.Authorization = "Bearer "; }],
    ["nonbearer", (entry) => { entry.configuration.headers.Authorization = "Basic fixture"; }],
    ["readable mismatch", (entry) => { entry.configuration.headers.Authorization = `Bearer ${OTHER}`; }],
    ["nonstring authorization", (entry) => { entry.configuration.headers.Authorization = 42; }],
  ];

  it.each(malformedTargets)("rejects late %s before any gateway probe or mutation", async (_name, mutate) => {
    for (const command of ["prepare", "configure"]) {
      const destinations = existing();
      mutate(destinations[1]);
      const state = fixture({ destinations, exposeHeaders: true });
      await expect(state.run(command)).rejects.toThrow();
      expectNoSideEffects(state);
    }
  });

  it("rejects a malformed target on the second list page before changing a valid first target", async () => {
    const fillers = Array.from({ length: 49 }, (_, index) => ({ name: `unrelated-${index}` }));
    const late = destination(TARGETS[1]);
    late.slug = "";
    const state = fixture({ destinations: [destination(TARGETS[0]), ...fillers, late] });
    await expect(state.run()).rejects.toThrow();
    expect(state.api.map((event) => event.url.searchParams.get("page"))).toEqual(["1", "2"]);
    expectNoSideEffects(state);
  });

  it("rejects duplicate named destinations discovered on a later page before probing or writing", async () => {
    const fillers = Array.from({ length: 48 }, (_, index) => ({ name: `unrelated-${index}` }));
    const state = fixture({ destinations: [...existing(), ...fillers, destination(TARGETS[0])] });
    await expect(state.run()).rejects.toThrow();
    expect(state.api).toHaveLength(2);
    expectNoSideEffects(state);
  });

  it("rejects two targeted destinations sharing one slug before probing or writing", async () => {
    const destinations = existing();
    destinations[1].slug = destinations[0].slug;
    const state = fixture({ destinations });
    await expect(state.run()).rejects.toThrow();
    expectNoSideEffects(state);
  });

  it.each([null, [], {}, { name: "" }])("rejects malformed listing row %j", async (entry) => {
    const state = fixture({ destinations: [destination(TARGETS[0]), entry] });
    await expect(state.run()).rejects.toThrow();
    expectNoSideEffects(state);
  });

  it.each([null, {}, "not-a-list"])("rejects malformed listing result %j", async (result) => {
    const state = fixture({ listTransform: () => result });
    await expect(state.run()).rejects.toThrow();
    expectNoSideEffects(state);
  });

  it("rejects pages larger than the requested limit", async () => {
    const state = fixture({
      apiResponse: () => Response.json({ success: true, result: Array.from({ length: 51 }, () => ({ name: "unrelated" })) }),
    });
    await expect(state.run()).rejects.toThrow();
    expectNoSideEffects(state);
  });

  it("stops pagination at the supported 1,000-page bound without probing or writing", async () => {
    const state = fixture({
      apiResponse: () => Response.json({ success: true, result: Array.from({ length: 50 }, (_, index) => ({ name: `unrelated-${index}` })) }),
    });
    await expect(state.run()).rejects.toThrow();
    expect(state.api).toHaveLength(1_000);
    expect(state.api.at(-1).url.searchParams.get("page")).toBe("1000");
    expectNoSideEffects(state);
  });

  it("accepts one case-insensitive Authorization property", async () => {
    const destinations = existing();
    destinations[0].configuration.headers = { authorization: null };
    destinations[1].configuration.headers = { AUTHORIZATION: `Bearer ${PREVIOUS}` };
    const state = fixture({ destinations, exposeHeaders: true });
    await state.run();
    expectWrittenBearer(state, CURRENT);
  });

  it.each([
    "https://untrusted.example.test/v1/traces",
    `${ORIGIN}/v1/logs`,
    `${ORIGIN}/v1/traces?query=1`,
    `${ORIGIN}/v1/traces#fragment`,
    `${ORIGIN}/v1/traces/`,
    `http://gateway.example.test/v1/traces`,
  ])("rejects the existing URL %s before probing or writing", async (url) => {
    const destinations = existing();
    destinations[1].configuration.url = url;
    const state = fixture({ destinations });
    await expect(state.run()).rejects.toThrow();
    expectNoSideEffects(state);
  });

  it.each([
    "http://gateway.example.test",
    "http://127.0.0.1:1234",
    `${ORIGIN}/path`,
    `${ORIGIN}/`,
    `${ORIGIN}?query=1`,
    `${ORIGIN}#fragment`,
    "https://user:password@gateway.example.test",
    "https://gateway.example.test:444",
    "not-a-url",
  ])("rejects configured non-origin URL %s before any request", async (origin) => {
    const state = fixture();
    await expect(state.run("configure", { ...SOURCE, TELEMETRY_GATEWAY_ORIGIN: origin })).rejects.toThrow();
    expect(state.events).toHaveLength(0);
  });
});

describe("fail-closed authentication and readback", () => {
  const ambiguous = [
    ["invalid control accepted", () => 413],
    ["invalid control mixed", (probe) => probe.bearer === CURRENT ? 413 : probe.url.pathname === "/v1/logs" ? 200 : 413],
    ["candidate mixed", (probe) => probe.bearer === CURRENT && probe.url.pathname === "/v1/logs" ? 413 : 200],
    ["candidate upstream error", (probe) => probe.bearer === CURRENT ? 503 : 200],
    ["candidate redirect", (probe) => probe.bearer === CURRENT ? 302 : 200],
    ["control redirect", (probe) => probe.bearer === CURRENT ? 413 : 307],
    ["network failure", () => { throw new Error(`network ${CURRENT} ${PREVIOUS} ${SOURCE.CLOUDFLARE_API_TOKEN}`); }],
  ];

  it.each(ambiguous)("rejects %s without fallback or writes", async (_name, gatewayStatus) => {
    const state = fixture({ gatewayStatus });
    const error = await state.run("prepare").then(() => undefined, (failure) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(state.writes).toHaveLength(0);
    expect(state.probes.some((probe) => probe.bearer === PREVIOUS)).toBe(false);
    for (const secret of [CURRENT, PREVIOUS, SOURCE.CLOUDFLARE_API_TOKEN]) {
      expect(error.message).not.toContain(secret);
      expect(state.output.join("")).not.toContain(secret);
    }
  });

  it.each([302, 403, 500])("rejects Cloudflare HTTP %s without exposing response contents", async (status) => {
    const state = fixture({
      apiResponse: () => Response.json({ success: false, errors: [{ message: `${CURRENT} ${PREVIOUS} ${SOURCE.CLOUDFLARE_API_TOKEN}` }] }, { status }),
    });
    const error = await state.run().then(() => undefined, (failure) => failure);
    expect(error).toBeInstanceOf(Error);
    expectNoSideEffects(state);
    expect(state.api[0].init.redirect).toBe("error");
    for (const secret of [CURRENT, PREVIOUS, SOURCE.CLOUDFLARE_API_TOKEN]) expect(error.message).not.toContain(secret);
  });

  it("sanitizes Cloudflare transport errors before any runtime probe", async () => {
    const state = fixture({ apiResponse: () => { throw new Error(`network ${SOURCE.CLOUDFLARE_API_TOKEN}`); } });
    const error = await state.run().then(() => undefined, (failure) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain(SOURCE.CLOUDFLARE_API_TOKEN);
    expectNoSideEffects(state);
  });

  it("rejects readable final-header mismatch even though writes and runtime authentication succeeded", async () => {
    const state = fixture({ listTransform: (entries, listing) => {
      if (listing > 1) entries[1].configuration.headers.Authorization = `Bearer ${PREVIOUS}`;
      return entries;
    } });
    await expect(state.run()).rejects.toThrow();
    expectWrittenBearer(state, CURRENT);
  });

  it("rejects prepare readback exposing current when the proven staging bearer was previous", async () => {
    const state = fixture({
      accepted: [PREVIOUS],
      listTransform: (entries, listing) => {
        if (listing > 1) entries[1].configuration.headers.Authorization = `Bearer ${CURRENT}`;
        return entries;
      },
    });
    await expect(state.run("prepare")).rejects.toThrow();
    expectWrittenBearer(state, PREVIOUS);
  });

  it.each([
    ["type", (entry) => { entry.configuration.type = "http"; }],
    ["URL", (entry) => { entry.configuration.url = `${ORIGIN}/v1/logs`; }],
    ["dataset", (entry) => { entry.configuration.logpushDataset = "opentelemetry-logs"; }],
    ["enabled", (entry) => { entry.enabled = false; }],
    ["slug", (entry) => { entry.slug = ""; }],
    ["missing target", (_entry, entries) => { entries.pop(); }],
    ["duplicate", (_entry, entries) => { entries.push(structuredClone(entries[1])); }],
    ["malformed extra header", (entry) => { entry.configuration.headers.Extra = 42; }],
  ])("rejects final nonsecret %s drift", async (_name, mutate) => {
    const state = fixture({ listTransform: (entries, listing) => {
      if (listing > 1) mutate(entries[1], entries);
      return entries;
    } });
    await expect(state.run()).rejects.toThrow();
    expectWrittenBearer(state, CURRENT);
  });

  it("fails if the gateway stops accepting staging after prepare's successful write/readback", async () => {
    let currentProbes = 0;
    const state = fixture({ gatewayStatus: (probe) => {
      if (probe.bearer !== CURRENT) return 200;
      currentProbes += 1;
      return currentProbes <= 2 ? 413 : 200;
    } });
    await expect(state.run("prepare")).rejects.toThrow();
    expectWrittenBearer(state, CURRENT);
    expect(state.api.filter((event) => event.method === "GET")).toHaveLength(2);
  });

  it("fails if current stops authenticating after configure's successful write/readback", async () => {
    let currentProbes = 0;
    const state = fixture({ gatewayStatus: (probe) => {
      if (probe.bearer !== CURRENT) return 200;
      currentProbes += 1;
      return currentProbes <= 2 ? 413 : 200;
    } });
    await expect(state.run()).rejects.toThrow();
    expectWrittenBearer(state, CURRENT);
  });
});

describe("Cloudflare destination payloads", () => {
  it("sends the immutable dataset only while creating a destination", () => {
    const target = TARGETS[0];
    expect(destinationPayload(target, ORIGIN, CURRENT, "create")).toEqual({
      name: target.name,
      enabled: true,
      configuration: {
        type: "logpush",
        url: `${ORIGIN}${target.path}`,
        headers: { Authorization: `Bearer ${CURRENT}` },
        logpushDataset: target.dataset,
      },
    });
    expect(destinationPayload(target, ORIGIN, CURRENT, "update")).toEqual({
      enabled: true,
      configuration: {
        type: "logpush",
        url: `${ORIGIN}${target.path}`,
        headers: { Authorization: `Bearer ${CURRENT}` },
      },
    });
  });
});
