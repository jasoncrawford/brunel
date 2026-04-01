import { describe, expect, it } from "vitest";
import { generateWorkerId, PURITAN_NAMES, shortWorkerId } from "../src/utils.js";

describe("generateWorkerId", () => {
  it("returns a string with a Puritan name prefix followed by a UUID", () => {
    const id = generateWorkerId();
    // Format: <name>-<uuid>
    const parts = id.split("-");
    // UUID has 5 parts; name adds 1 more at the front
    expect(parts.length).toBe(6);
    expect(PURITAN_NAMES).toContain(parts[0]);
  });

  it("contains a valid UUID after the name prefix", () => {
    const id = generateWorkerId();
    const uuidPart = id.slice(id.indexOf("-") + 1);
    expect(uuidPart).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("uses lowercase names", () => {
    for (let i = 0; i < 20; i++) {
      const id = generateWorkerId();
      const name = id.split("-")[0];
      expect(name).toBe(name.toLowerCase());
    }
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateWorkerId()));
    expect(ids.size).toBe(100);
  });

  it("PURITAN_NAMES contains at least 20 names", () => {
    expect(PURITAN_NAMES.length).toBeGreaterThanOrEqual(20);
  });
});

describe("shortWorkerId", () => {
  it("shows name + first 8 chars of UUID for named worker IDs", () => {
    expect(shortWorkerId("justice-e706451f-c3bc-4035-a7df-12c7040a196a")).toBe("justice-e706451f");
  });

  it("shows name + first 8 chars of UUID for another named worker ID", () => {
    expect(shortWorkerId("nehemiah-375d3d1c-f94c-49bf-a715-f539f1a16ae2")).toBe("nehemiah-375d3d1c");
  });

  it("falls back to first 8 chars for legacy bare UUID worker IDs", () => {
    expect(shortWorkerId("7c254628-bc1d-4379-b35e-eb139e008c70")).toBe("7c254628");
  });

  it("works for generated worker IDs", () => {
    const id = generateWorkerId();
    const short = shortWorkerId(id);
    const namePart = id.split("-")[0];
    const uuidFirst8 = id.slice(namePart.length + 1, namePart.length + 9);
    expect(short).toBe(`${namePart}-${uuidFirst8}`);
  });
});
