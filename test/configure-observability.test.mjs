import { describe, expect, it } from "vitest";
import {
  destinationPayload,
  verifyConfiguredDestinationBearers,
  verifyExistingBearerRotation,
} from "../scripts/configure-observability.mjs";

const destinations = [
  {
    name: "watch-pr-azure-logs",
    configuration: { headers: { Authorization: "Bearer previous-bearer" } },
  },
  {
    name: "watch-pr-azure-traces",
    configuration: { headers: { Authorization: "Bearer previous-bearer" } },
  },
];

describe("observability destination bearer rotation", () => {
  it("allows destination traffic through the overlapping gateway bearer set", () => {
    expect(() => verifyExistingBearerRotation(destinations, ["current-bearer", "previous-bearer"])).not.toThrow();
  });

  it("stops a bearer replacement that would drop existing destination traffic", () => {
    expect(() => verifyExistingBearerRotation(destinations, ["current-bearer"])).toThrow("absent from the gateway's accepted set");
  });

  it("requires every destination to receive the current bearer before retiring overlap", () => {
    const currentDestinations = destinations.map((destination) => ({
      ...destination,
      configuration: { headers: { Authorization: "Bearer current-bearer" } },
    }));

    expect(() => verifyConfiguredDestinationBearers(currentDestinations, "current-bearer")).not.toThrow();
    expect(() => verifyConfiguredDestinationBearers(destinations, "current-bearer")).toThrow("did not retain");
  });
});

describe("Cloudflare destination payloads", () => {
  const destination = {
    name: "watch-pr-azure-logs",
    dataset: "opentelemetry-logs",
    path: "/v1/logs",
  };
  const origin = "https://watch-pr-telemetry-gateway.example.workers.dev";
  const bearer = "current-bearer";

  it("sends the immutable dataset only while creating a destination", () => {
    expect(destinationPayload(destination, origin, bearer, "create")).toEqual({
      name: destination.name,
      enabled: true,
      configuration: {
        type: "logpush",
        url: `${origin}${destination.path}`,
        headers: { Authorization: `Bearer ${bearer}` },
        logpushDataset: destination.dataset,
      },
    });
    expect(destinationPayload(destination, origin, bearer, "update")).toEqual({
      enabled: true,
      configuration: {
        type: "logpush",
        url: `${origin}${destination.path}`,
        headers: { Authorization: `Bearer ${bearer}` },
      },
    });
  });
});
