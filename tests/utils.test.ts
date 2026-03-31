import { describe, expect, it } from "vitest";
import { generateWorkerId, PURITAN_NAMES } from "../src/utils.js";

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
