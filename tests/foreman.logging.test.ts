import { describe, it, expect } from "vitest";
import { summaryEvent } from "../src/foreman.js";

describe("summaryEvent", () => {
  it("renders a single line with no newlines", () => {
    const result = summaryEvent("id-1", "issues", {
      action: "labeled",
      issue: { number: 42, title: "Fix the bug" },
      sender: { login: "alice" },
      repository: { full_name: "owner/repo" },
    });
    expect(result).not.toContain("\n");
  });

  it("includes event name and action for issues/labeled", () => {
    const result = summaryEvent("id-1", "issues", {
      action: "labeled",
      issue: { number: 42, title: "Fix the bug" },
      sender: { login: "alice" },
      repository: { full_name: "owner/repo" },
    });
    expect(result).toMatch(/issues\/labeled/);
    expect(result).toContain("#42");
    expect(result).toContain("Fix the bug");
    expect(result).toContain("alice");
    expect(result).toContain("owner/repo");
  });

  it("includes event name and action for issue_comment/created", () => {
    const result = summaryEvent("id-2", "issue_comment", {
      action: "created",
      issue: { number: 7, title: "Another issue" },
      comment: { body: "Great work!" },
      sender: { login: "bob" },
      repository: { full_name: "owner/repo" },
    });
    expect(result).toMatch(/issue_comment\/created/);
    expect(result).toContain("#7");
    expect(result).toContain("bob");
  });

  it("includes PR number for pull_request events", () => {
    const result = summaryEvent("id-3", "pull_request", {
      action: "opened",
      pull_request: { number: 5, title: "Add feature" },
      sender: { login: "carol" },
      repository: { full_name: "owner/repo" },
    });
    expect(result).toMatch(/pull_request\/opened/);
    expect(result).toContain("#5");
    expect(result).toContain("Add feature");
    expect(result).not.toContain("\n");
  });

  it("includes ref and commit count for push events", () => {
    const result = summaryEvent("id-4", "push", {
      ref: "refs/heads/main",
      commits: [{}, {}, {}],
      sender: { login: "dave" },
      repository: { full_name: "owner/repo" },
    });
    expect(result).toContain("push");
    expect(result).toContain("refs/heads/main");
    expect(result).toContain("3");
    expect(result).not.toContain("\n");
  });

  it("handles event with no action gracefully", () => {
    const result = summaryEvent("id-5", "ping", {
      sender: { login: "user" },
      repository: { full_name: "owner/repo" },
    });
    expect(result).toContain("ping");
    expect(result).not.toMatch(/ping\//);  // no slash after event name when no action
    expect(result).not.toContain("\n");
  });

  it("truncates long titles to stay concise", () => {
    const longTitle = "A".repeat(100);
    const result = summaryEvent("id-6", "issues", {
      action: "opened",
      issue: { number: 1, title: longTitle },
      repository: { full_name: "owner/repo" },
    });
    expect(result).not.toContain("\n");
    // The full 100-char title should not appear verbatim
    expect(result).not.toContain(longTitle);
  });

  it("omits sender when not present", () => {
    const result = summaryEvent("id-7", "issues", {
      action: "opened",
      issue: { number: 1, title: "Test" },
      repository: { full_name: "owner/repo" },
    });
    expect(result).not.toContain("by undefined");
    expect(result).not.toContain("by null");
  });

  it("omits repo when not present", () => {
    const result = summaryEvent("id-8", "issues", {
      action: "opened",
      issue: { number: 1, title: "Test" },
    });
    expect(result).not.toContain("undefined");
    expect(result).not.toContain("null");
  });
});
