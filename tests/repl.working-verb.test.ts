import { describe, it, expect } from "vitest";
import { WORKING_VERBS, pickWorkingVerb } from "../src/agent/display.js";

describe("WORKING_VERBS", () => {
  it("is a non-empty array", () => {
    expect(Array.isArray(WORKING_VERBS)).toBe(true);
    expect(WORKING_VERBS.length).toBeGreaterThan(0);
  });

  it("contains only non-empty strings", () => {
    for (const verb of WORKING_VERBS) {
      expect(typeof verb).toBe("string");
      expect(verb.length).toBeGreaterThan(0);
    }
  });

  it("includes expected construction/engineering verbs", () => {
    // At minimum these theme-appropriate verbs should be present
    const lower = WORKING_VERBS.map((v) => v.toLowerCase());
    expect(lower).toContain("building");
    expect(lower).toContain("constructing");
  });
});

describe("pickWorkingVerb", () => {
  it("returns a string from WORKING_VERBS", () => {
    const verb = pickWorkingVerb();
    expect(WORKING_VERBS).toContain(verb);
  });

  it("returns different verbs over many calls (not always the same)", () => {
    // With enough calls, we should see more than one unique verb (probabilistic)
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(pickWorkingVerb());
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});
