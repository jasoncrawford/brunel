import { describe, it, expect } from "vitest";
import { fmtError } from "../src/utils.js";

describe("fmtError", () => {
  it("returns the message for a native Error", () => {
    expect(fmtError(new Error("something broke"))).toBe("something broke");
  });

  it("returns the message for a Supabase-style PostgrestError (plain object with message)", () => {
    const supabaseError = { message: "relation \"task_assignments\" does not exist", code: "42P01", details: null, hint: null };
    expect(fmtError(supabaseError)).toBe("relation \"task_assignments\" does not exist");
  });

  it("returns the string itself for a string error", () => {
    expect(fmtError("oops")).toBe("oops");
  });

  it("returns JSON for an object without a message field", () => {
    expect(fmtError({ code: 500 })).toBe('{"code":500}');
  });

  it("handles null gracefully", () => {
    expect(fmtError(null)).toBe("null");
  });

  it("handles undefined gracefully", () => {
    expect(fmtError(undefined)).toBe("undefined");
  });
});
