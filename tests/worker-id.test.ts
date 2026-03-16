import { describe, it, expect } from "vitest";
import { getWorkerId } from "../src/worker-id.js";

describe("getWorkerId", () => {
  it("returns a valid UUID", () => {
    const id = getWorkerId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("returns a different id on each call", () => {
    const id1 = getWorkerId();
    const id2 = getWorkerId();
    expect(id1).not.toBe(id2);
  });
});
