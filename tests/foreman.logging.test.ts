import { describe, it, expect } from "vitest";
import { WebhookEvent } from "../src/foreman/models/webhook-event.js";

function evt(name: string, payload: Record<string, unknown> = {}): WebhookEvent {
  return WebhookEvent.fromIncoming("test-id", name, payload);
}

describe("WebhookEvent.isMuted", () => {
  it("mutes workflow_job events", () => {
    expect(evt("workflow_job").isMuted()).toBe(true);
  });

  it("mutes workflow_run events", () => {
    expect(evt("workflow_run").isMuted()).toBe(true);
  });

  it("does not mute check_run events", () => {
    expect(evt("check_run").isMuted()).toBe(false);
  });

  it("does not mute check_suite events", () => {
    expect(evt("check_suite").isMuted()).toBe(false);
  });

  it("does not mute issues events", () => {
    expect(evt("issues").isMuted()).toBe(false);
  });

  it("does not mute pull_request events", () => {
    expect(evt("pull_request").isMuted()).toBe(false);
  });
});

describe("WebhookEvent.summary", () => {
  it("renders a single line with no newlines", () => {
    const result = evt("issues", {
      action: "labeled",
      issue: { number: 42, title: "Fix the bug" },
      sender: { login: "alice" },
      repository: { full_name: "owner/repo" },
    }).summary();
    expect(result).not.toContain("\n");
  });

  it("includes event name and action for issues/labeled", () => {
    const result = evt("issues", {
      action: "labeled",
      issue: { number: 42, title: "Fix the bug" },
      sender: { login: "alice" },
      repository: { full_name: "owner/repo" },
    }).summary();
    expect(result).toMatch(/issues\/labeled/);
    expect(result).toContain("#42");
    expect(result).toContain("Fix the bug");
    expect(result).toContain("alice");
    expect(result).toContain("owner/repo");
  });

  it("includes event name and action for issue_comment/created", () => {
    const result = evt("issue_comment", {
      action: "created",
      issue: { number: 7, title: "Another issue" },
      comment: { body: "Great work!" },
      sender: { login: "bob" },
      repository: { full_name: "owner/repo" },
    }).summary();
    expect(result).toMatch(/issue_comment\/created/);
    expect(result).toContain("#7");
    expect(result).toContain("bob");
  });

  it("includes PR number for pull_request events", () => {
    const result = evt("pull_request", {
      action: "opened",
      pull_request: { number: 5, title: "Add feature" },
      sender: { login: "carol" },
      repository: { full_name: "owner/repo" },
    }).summary();
    expect(result).toMatch(/pull_request\/opened/);
    expect(result).toContain("#5");
    expect(result).toContain("Add feature");
    expect(result).not.toContain("\n");
  });

  it("includes ref and commit count for push events", () => {
    const result = evt("push", {
      ref: "refs/heads/main",
      commits: [{}, {}, {}],
      sender: { login: "dave" },
      repository: { full_name: "owner/repo" },
    }).summary();
    expect(result).toContain("push");
    expect(result).toContain("refs/heads/main");
    expect(result).toContain("3");
    expect(result).not.toContain("\n");
  });

  it("handles event with no action gracefully", () => {
    const result = evt("ping", {
      sender: { login: "user" },
      repository: { full_name: "owner/repo" },
    }).summary();
    expect(result).toContain("ping");
    expect(result).not.toMatch(/ping\//);  // no slash after event name when no action
    expect(result).not.toContain("\n");
  });

  it("truncates long titles to stay concise", () => {
    const longTitle = "A".repeat(100);
    const result = evt("issues", {
      action: "opened",
      issue: { number: 1, title: longTitle },
      repository: { full_name: "owner/repo" },
    }).summary();
    expect(result).not.toContain("\n");
    expect(result).not.toContain(longTitle);
  });

  it("omits sender when not present", () => {
    const result = evt("issues", {
      action: "opened",
      issue: { number: 1, title: "Test" },
      repository: { full_name: "owner/repo" },
    }).summary();
    expect(result).not.toContain("by undefined");
    expect(result).not.toContain("by null");
  });

  it("omits repo when not present", () => {
    const result = evt("issues", {
      action: "opened",
      issue: { number: 1, title: "Test" },
    }).summary();
    expect(result).not.toContain("undefined");
    expect(result).not.toContain("null");
  });

  it("includes PR number for check_run with pull_requests", () => {
    const result = evt("check_run", {
      action: "completed",
      check_run: {
        name: "CI",
        conclusion: "success",
        pull_requests: [{ number: 12 }],
      },
      sender: { login: "bot" },
      repository: { full_name: "owner/repo" },
    }).summary();
    expect(result).toContain("#12");
    expect(result).not.toContain("\n");
  });

  it("includes head_branch for check_run when no pull_requests", () => {
    const result = evt("check_run", {
      action: "completed",
      check_run: {
        name: "CI",
        conclusion: "success",
        pull_requests: [],
        check_suite: { head_branch: "fix/my-branch" },
      },
      sender: { login: "bot" },
      repository: { full_name: "owner/repo" },
    }).summary();
    expect(result).toContain("fix/my-branch");
    expect(result).not.toContain("\n");
  });

  it("includes PR number for check_suite with pull_requests", () => {
    const result = evt("check_suite", {
      action: "completed",
      check_suite: {
        head_branch: "feature/x",
        pull_requests: [{ number: 99 }],
      },
      sender: { login: "bot" },
      repository: { full_name: "owner/repo" },
    }).summary();
    expect(result).toContain("#99");
    expect(result).not.toContain("\n");
  });

  it("includes head_branch for check_suite when no pull_requests", () => {
    const result = evt("check_suite", {
      action: "completed",
      check_suite: {
        head_branch: "feature/my-feature",
        pull_requests: [],
      },
      sender: { login: "bot" },
      repository: { full_name: "owner/repo" },
    }).summary();
    expect(result).toContain("feature/my-feature");
    expect(result).not.toContain("\n");
  });

  it("includes PR number for workflow_run with pull_requests", () => {
    const result = evt("workflow_run", {
      action: "completed",
      workflow_run: {
        name: "CI",
        conclusion: "success",
        pull_requests: [{ number: 77 }],
      },
      sender: { login: "bot" },
      repository: { full_name: "owner/repo" },
    }).summary();
    expect(result).toContain("#77");
    expect(result).not.toContain("\n");
  });

  it("includes head_branch for workflow_run when no pull_requests", () => {
    const result = evt("workflow_run", {
      action: "completed",
      workflow_run: {
        name: "CI",
        head_branch: "fix/53-something",
        pull_requests: [],
      },
      sender: { login: "bot" },
      repository: { full_name: "owner/repo" },
    }).summary();
    expect(result).toContain("fix/53-something");
    expect(result).not.toContain("\n");
  });

  it("includes PR number for workflow_job with pull_requests", () => {
    const result = evt("workflow_job", {
      action: "completed",
      workflow_job: {
        name: "build",
        conclusion: "success",
        pull_requests: [{ number: 55 }],
      },
      sender: { login: "bot" },
      repository: { full_name: "owner/repo" },
    }).summary();
    expect(result).toContain("#55");
    expect(result).not.toContain("\n");
  });

  it("includes head_branch for workflow_job when no pull_requests", () => {
    const result = evt("workflow_job", {
      action: "completed",
      workflow_job: {
        name: "build",
        head_branch: "fix/issue-61",
        pull_requests: [],
      },
      sender: { login: "bot" },
      repository: { full_name: "owner/repo" },
    }).summary();
    expect(result).toContain("fix/issue-61");
    expect(result).not.toContain("\n");
  });

  it("includes ref for delete events", () => {
    const result = evt("delete", {
      ref: "fix/53-webhook-assignment",
      ref_type: "branch",
      sender: { login: "alice" },
      repository: { full_name: "owner/repo" },
    }).summary();
    expect(result).toContain("fix/53-webhook-assignment");
    expect(result).not.toContain("\n");
  });
});
