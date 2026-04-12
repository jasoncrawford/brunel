/**
 * Tests for fmtTime and fmtEventDetails — helper functions that format
 * timestamps and event-specific details for worker event_notification lines.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { fmtTime, fmtEventDetails } from "../src/agent/display.js";
import * as Wire from "../shared/wire.js";

afterEach(() => {
  vi.useRealTimers();
});

// ── fmtTime ──────────────────────────────────────────────────────────────────

describe("fmtTime", () => {
  it("returns HH:MM:SS format", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-17T14:05:03.000Z"));
    expect(fmtTime()).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

// ── fmtEventDetails ──────────────────────────────────────────────────────────

describe("fmtEventDetails - check_run", () => {
  it("includes check run name and conclusion", () => {
    const event: Wire.WebhookEvent = {
      id: "evt-1",
      name: "check_run",
      payload: {
        action: "completed",
        check_run: { name: "CI / build", conclusion: "success" },
      },
    };
    const result = fmtEventDetails(event);
    expect(result).toContain("CI / build");
    expect(result).toContain("success");
  });

  it("uses status when conclusion is missing", () => {
    const event: Wire.WebhookEvent = {
      id: "evt-2",
      name: "check_run",
      payload: {
        action: "in_progress",
        check_run: { name: "CI / lint", status: "in_progress", conclusion: null },
      },
    };
    const result = fmtEventDetails(event);
    expect(result).toContain("CI / lint");
    expect(result).toContain("in_progress");
  });
});

describe("fmtEventDetails - check_suite", () => {
  it("includes conclusion", () => {
    const event: Wire.WebhookEvent = {
      id: "evt-3",
      name: "check_suite",
      payload: {
        action: "completed",
        check_suite: { conclusion: "failure" },
      },
    };
    expect(fmtEventDetails(event)).toContain("failure");
  });
});

describe("fmtEventDetails - issue_comment", () => {
  it("includes truncated body", () => {
    const event: Wire.WebhookEvent = {
      id: "evt-4",
      name: "issue_comment",
      payload: {
        action: "created",
        comment: { body: "This looks good to me" },
      },
    };
    expect(fmtEventDetails(event)).toContain("This looks good to me");
  });

  it("truncates long body", () => {
    const longBody = "A".repeat(200);
    const event: Wire.WebhookEvent = {
      id: "evt-5",
      name: "issue_comment",
      payload: { action: "created", comment: { body: longBody } },
    };
    const result = fmtEventDetails(event);
    expect(result.length).toBeLessThan(150);
    expect(result).toContain("…");
  });
});

describe("fmtEventDetails - pull_request_review_comment", () => {
  it("includes truncated body", () => {
    const event: Wire.WebhookEvent = {
      id: "evt-6",
      name: "pull_request_review_comment",
      payload: {
        action: "created",
        comment: { body: "Can we rename this variable?" },
      },
    };
    expect(fmtEventDetails(event)).toContain("Can we rename this variable?");
  });
});

describe("fmtEventDetails - pull_request_review", () => {
  it("includes review state", () => {
    const event: Wire.WebhookEvent = {
      id: "evt-7",
      name: "pull_request_review",
      payload: {
        action: "submitted",
        review: { state: "approved", body: "" },
      },
    };
    expect(fmtEventDetails(event)).toContain("approved");
  });

  it("includes truncated body when present", () => {
    const event: Wire.WebhookEvent = {
      id: "evt-8",
      name: "pull_request_review",
      payload: {
        action: "submitted",
        review: { state: "changes_requested", body: "Please fix the tests" },
      },
    };
    const result = fmtEventDetails(event);
    expect(result).toContain("changes_requested");
    expect(result).toContain("Please fix the tests");
  });
});

describe("fmtEventDetails - pull_request", () => {
  it("includes PR number and title", () => {
    const event: Wire.WebhookEvent = {
      id: "evt-9",
      name: "pull_request",
      payload: {
        action: "opened",
        pull_request: { number: 42, title: "Add feature X" },
      },
    };
    const result = fmtEventDetails(event);
    expect(result).toContain("42");
    expect(result).toContain("Add feature X");
  });
});

describe("fmtEventDetails - push", () => {
  it("includes ref and commit count", () => {
    const event: Wire.WebhookEvent = {
      id: "evt-10",
      name: "push",
      payload: {
        ref: "refs/heads/main",
        commits: [{}, {}, {}],
      },
    };
    const result = fmtEventDetails(event);
    expect(result).toContain("refs/heads/main");
    expect(result).toContain("3");
  });
});

describe("fmtEventDetails - workflow_run", () => {
  it("includes workflow name and conclusion", () => {
    const event: Wire.WebhookEvent = {
      id: "evt-11",
      name: "workflow_run",
      payload: {
        action: "completed",
        workflow_run: { name: "CI", conclusion: "success" },
      },
    };
    const result = fmtEventDetails(event);
    expect(result).toContain("CI");
    expect(result).toContain("success");
  });
});

describe("fmtEventDetails - delete", () => {
  it("includes ref_type and ref for a branch deletion", () => {
    const event: Wire.WebhookEvent = {
      id: "evt-12",
      name: "delete",
      payload: { ref_type: "branch", ref: "feature/my-branch" },
    };
    const result = fmtEventDetails(event);
    expect(result).toContain("branch");
    expect(result).toContain("feature/my-branch");
  });

  it("includes ref_type and ref for a tag deletion", () => {
    const event: Wire.WebhookEvent = {
      id: "evt-13",
      name: "delete",
      payload: { ref_type: "tag", ref: "v1.2.3" },
    };
    const result = fmtEventDetails(event);
    expect(result).toContain("tag");
    expect(result).toContain("v1.2.3");
  });
});

describe("fmtEventDetails - issues labeled", () => {
  it("includes label name for issues/labeled", () => {
    const event: Wire.WebhookEvent = {
      id: "evt-14",
      name: "issues",
      payload: {
        action: "labeled",
        label: { name: "bug" },
        issue: { number: 42, title: "Something broken" },
      },
    };
    const result = fmtEventDetails(event);
    expect(result).toContain("bug");
  });

  it("returns empty string for issues events without a label", () => {
    const event: Wire.WebhookEvent = {
      id: "evt-15",
      name: "issues",
      payload: { action: "closed", issue: { number: 42, title: "Something" } },
    };
    expect(fmtEventDetails(event)).toBe("");
  });
});

describe("fmtEventDetails - unknown event", () => {
  it("returns empty string for unknown event types", () => {
    const event: Wire.WebhookEvent = {
      id: "evt-16",
      name: "some_unknown_event",
      payload: {},
    };
    expect(fmtEventDetails(event)).toBe("");
  });
});
