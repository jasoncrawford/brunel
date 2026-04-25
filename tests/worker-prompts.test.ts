import { describe, it, expect } from "vitest";
import { buildInitialPrompt, buildEventPrompt } from "../src/agent/worker-prompts.js";
import * as Wire from "../shared/wire.js";

describe("buildInitialPrompt", () => {
  it("includes issue number, title, body, labels, and repoUrl", () => {
    const p = buildInitialPrompt({
      number: 42,
      title: "Fix bug",
      body: "It crashes",
      labels: ["bug"],
      repoUrl: "https://github.com/x/y",
    });
    expect(p).toContain("#42");
    expect(p).toContain("Fix bug");
    expect(p).toContain("It crashes");
    expect(p).toContain("bug");
    expect(p).toContain("https://github.com/x/y");
  });

  it("handles null body gracefully", () => {
    const p = buildInitialPrompt({
      number: 1,
      title: "T",
      body: null as unknown as string,
      labels: [],
      repoUrl: "https://github.com/x/y",
    });
    expect(p).toContain("no description");
  });

  it("handles empty body gracefully", () => {
    const p = buildInitialPrompt({
      number: 1,
      title: "T",
      body: "",
      labels: [],
      repoUrl: "https://github.com/x/y",
    });
    expect(p).toContain("no description");
  });

  it("handles empty labels array", () => {
    const p = buildInitialPrompt({
      number: 1,
      title: "T",
      body: "body",
      labels: [],
      repoUrl: "https://github.com/x/y",
    });
    expect(p).toContain("(none)");
  });

  it("handles multiple labels", () => {
    const p = buildInitialPrompt({
      number: 1,
      title: "T",
      body: "body",
      labels: ["bug", "help wanted", "brunel:ready"],
      repoUrl: "https://github.com/x/y",
    }, true);
    expect(p).toContain("bug");
    expect(p).toContain("help wanted");
    expect(p).toContain("brunel:ready");
  });

  it("isolated checkout — says 'own checkout' and clarifies no worktree needed", () => {
    const p = buildInitialPrompt({
      number: 1, title: "T", body: "body", labels: [], repoUrl: "https://github.com/x/y",
    }, true);
    expect(p).toContain("own checkout");
    expect(p).not.toContain("isolated worktree");
  });

  it("reminds worker to update project docs alongside code changes", () => {
    const p = buildInitialPrompt({
      number: 1, title: "T", body: "body", labels: [], repoUrl: "https://github.com/x/y",
    }, true);
    expect(p).toMatch(/project doc/i);
  });

  it("shared checkout — mentions worktree", () => {
    const p = buildInitialPrompt({
      number: 1, title: "T", body: "body", labels: [], repoUrl: "https://github.com/x/y",
    }, false);
    expect(p).toContain("worktree");
  });

});

describe("buildInitialPrompt — status-dependent prompts", () => {
  const baseIssue = {
    number: 99,
    title: "My Task",
    body: "Some work to do",
    labels: ["feature"],
    repoUrl: "https://github.com/x/y",
  };

  describe("status: assigned (default, no PR)", () => {
    it("uses the standard new-task prompt", () => {
      const p = buildInitialPrompt({ ...baseIssue, status: "assigned" }, true);
      expect(p).toContain("#99");
      expect(p).toContain("Please work on GitHub issue");
      expect(p).toContain("Create a PR when done");
    });

    it("default (no status field) behaves like assigned", () => {
      const p = buildInitialPrompt({ ...baseIssue }, true);
      expect(p).toContain("Please work on GitHub issue");
      expect(p).toContain("Create a PR when done");
    });
  });

  describe("status: pushed (open PR exists)", () => {
    it("mentions the open PR and its number", () => {
      const p = buildInitialPrompt(
        { ...baseIssue, status: "pushed", prNumber: 42, branch: "fix/my-task" },
        true,
      );
      expect(p).toContain("PR #42");
    });

    it("tells the worker to fetch and switch to the branch", () => {
      const p = buildInitialPrompt(
        { ...baseIssue, status: "pushed", prNumber: 42, branch: "fix/my-task" },
        true,
      );
      expect(p).toContain("fix/my-task");
      expect(p).toMatch(/fetch/i);
    });

    it("tells the worker to review code review comments", () => {
      const p = buildInitialPrompt(
        { ...baseIssue, status: "pushed", prNumber: 42, branch: "fix/my-task" },
        true,
      );
      expect(p).toMatch(/code review/i);
    });

    it("does NOT include the standard new-task Create-a-PR instruction", () => {
      const p = buildInitialPrompt(
        { ...baseIssue, status: "pushed", prNumber: 42, branch: "fix/my-task" },
        true,
      );
      expect(p).not.toContain("Create a PR when done");
    });
  });

  describe("status: merged (PR merged, issue still open)", () => {
    it("tells the worker the PR was merged", () => {
      const p = buildInitialPrompt({ ...baseIssue, status: "merged" }, true);
      expect(p).toMatch(/PR.*merged|merged.*PR/i);
    });

    it("tells the worker the issue was not closed and to determine next steps", () => {
      const p = buildInitialPrompt({ ...baseIssue, status: "merged" }, true);
      expect(p).toMatch(/not closed/i);
      expect(p).toMatch(/next steps?/i);
    });

    it("does NOT include the standard new-task Create-a-PR instruction", () => {
      const p = buildInitialPrompt({ ...baseIssue, status: "merged" }, true);
      expect(p).not.toContain("Create a PR when done");
    });
  });

  describe("status: closed (issue is closed)", () => {
    it("tells the worker the issue is closed", () => {
      const p = buildInitialPrompt({ ...baseIssue, status: "closed" }, true);
      expect(p).toMatch(/issue.*closed|closed.*issue/i);
    });

    it("instructs the worker to look for followup work", () => {
      const p = buildInitialPrompt({ ...baseIssue, status: "closed" }, true);
      expect(p).toMatch(/follow.?up/i);
    });

    it("does NOT include the standard new-task Create-a-PR instruction", () => {
      const p = buildInitialPrompt({ ...baseIssue, status: "closed" }, true);
      expect(p).not.toContain("Create a PR when done");
    });
  });
});

describe("buildEventPrompt", () => {
  it("returns multi-event fallback for 2+ events", () => {
    const events: Wire.WebhookEvent[] = [
      { id: "e1", name: "issue_comment", payload: {} },
      { id: "e2", name: "pull_request_review", payload: {} },
    ];
    const p = buildEventPrompt(events);
    expect(p).toContain("Multiple events");
  });

  it("renders individual event prompts — no raw template literals", () => {
    const events: Wire.WebhookEvent[] = [
      { id: "e1", name: "issue_comment", payload: {} },
      { id: "e2", name: "pull_request_review", payload: {} },
    ];
    const p = buildEventPrompt(events);
    expect(p).not.toContain("${");
  });

  it("pull_request_review — contains PR number, review state, and body", () => {
    const evt: Wire.WebhookEvent = {
      id: "e1",
      name: "pull_request_review",
      payload: {
        pull_request: { number: 5 },
        review: { state: "changes_requested", body: "Please fix X" },
      },
    };
    const p = buildEventPrompt([evt]);
    expect(p).toContain("PR #5");
    expect(p).toContain("changes_requested");
    expect(p).toContain("Please fix X");
  });

  it("pull_request_review_comment — contains PR number, file path, and body", () => {
    const evt: Wire.WebhookEvent = {
      id: "e1",
      name: "pull_request_review_comment",
      payload: {
        pull_request: { number: 7 },
        comment: { path: "src/foo.ts", body: "This line is wrong" },
      },
    };
    const p = buildEventPrompt([evt]);
    expect(p).toContain("PR #7");
    expect(p).toContain("src/foo.ts");
    expect(p).toContain("This line is wrong");
  });

  it("pull_request_review_comment with line number → includes line in location", () => {
    const events: Wire.WebhookEvent[] = [
      {
        id: "e1",
        name: "pull_request_review_comment",
        payload: {
          action: "created",
          pull_request: { number: 7 },
          comment: { body: "Nit: rename this", path: "src/foo.ts", line: 55, start_line: null },
        },
      },
    ];
    const p = buildEventPrompt(events);
    expect(p).toContain("`src/foo.ts` line 55");
  });

  it("issue_comment — contains issue number and comment body", () => {
    const evt: Wire.WebhookEvent = {
      id: "e1",
      name: "issue_comment",
      payload: {
        issue: { number: 12 },
        comment: { body: "Can you also handle edge case Y?" },
      },
    };
    const p = buildEventPrompt([evt]);
    expect(p).toContain("#12");
    expect(p).toContain("Can you also handle edge case Y?");
  });

  it("unknown event type — returns empty string (unrecognised events are log_only, never reach prompt builder)", () => {
    const evt: Wire.WebhookEvent = { id: "e1", name: "deployment", payload: {} };
    const p = buildEventPrompt([evt]);
    expect(p).toBe("");
  });

  describe("pull_request/closed", () => {
    it("merged PR — includes PR number and 'merged'", () => {
      const evt: Wire.WebhookEvent = {
        id: "e1",
        name: "pull_request",
        payload: {
          action: "closed",
          pull_request: { number: 10, merged: true },
        },
      };
      const p = buildEventPrompt([evt]);
      expect(p).toContain("PR #10");
      expect(p).toContain("merged");
    });

    it("closed-without-merge PR — includes PR number and 'closed without merging'", () => {
      const evt: Wire.WebhookEvent = {
        id: "e1",
        name: "pull_request",
        payload: {
          action: "closed",
          pull_request: { number: 10, merged: false },
        },
      };
      const p = buildEventPrompt([evt]);
      expect(p).toContain("PR #10");
      expect(p).toContain("closed without merging");
    });
  });

});

describe("check_suite success prompt", () => {
  it("includes instruction to wait for remaining tests before acting", () => {
    const events: Wire.WebhookEvent[] = [
      { id: "e1", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success", name: "CI" } } },
    ];
    const p = buildEventPrompt(events);
    expect(p).toContain("all tests passed");
    expect(p).toContain("wait");
  });

  it("branch-review prompt reminds to check docs", () => {
    const events: Wire.WebhookEvent[] = [
      { id: "e1", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success", name: "CI" } } },
    ];
    const p = buildEventPrompt(events);
    expect(p).toContain("documentation");
  });
});

describe("buildEventPrompt — pipeline behavior", () => {
  it("single event → no 'Multiple events have happened' prefix", () => {
    const events: Wire.WebhookEvent[] = [
      { id: "e1", name: "issue_comment", payload: { issue: { number: 1 }, comment: { body: "hello" } } },
    ];
    const p = buildEventPrompt(events);
    expect(p).not.toContain("Multiple events have happened");
  });

  it("multiple events after coalescing → 'Multiple events have happened:' prefix", () => {
    const events: Wire.WebhookEvent[] = [
      { id: "e1", name: "issue_comment", payload: { issue: { number: 1 }, comment: { body: "hello" } } },
      { id: "e2", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success", name: "CI" } } },
    ];
    const p = buildEventPrompt(events);
    expect(p).toContain("Multiple events have happened:");
  });

  it("multiple check suites coalesce to one → no 'Multiple events' prefix", () => {
    const events: Wire.WebhookEvent[] = [
      { id: "e1", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success", name: "CI / test" } } },
      { id: "e2", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success", name: "CI / lint" } } },
    ];
    const p = buildEventPrompt(events);
    expect(p).not.toContain("Multiple events have happened");
  });

  it("multiple events → joined with separator", () => {
    const events: Wire.WebhookEvent[] = [
      { id: "e1", name: "issue_comment", payload: { issue: { number: 1 }, comment: { body: "hello" } } },
      { id: "e2", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success", name: "CI" } } },
    ];
    const p = buildEventPrompt(events);
    expect(p).toContain("---");
  });

  it("issue_comment sorts before _check_suites in multi-event output", () => {
    const events: Wire.WebhookEvent[] = [
      { id: "e1", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success", name: "CI" } } },
      { id: "e2", name: "issue_comment", payload: { issue: { number: 1 }, comment: { body: "UAT comment" } } },
    ];
    const p = buildEventPrompt(events);
    const commentIdx = p.indexOf("UAT comment");
    const checkIdx = p.indexOf("Checks succeeded");
    expect(commentIdx).toBeLessThan(checkIdx);
  });

  it("check_suite failure → mentions failed check names and instructs to fix", () => {
    const events: Wire.WebhookEvent[] = [
      { id: "e1", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "failure", name: "CI / tests" } } },
    ];
    const p = buildEventPrompt(events);
    expect(p).toContain("CI / tests");
    expect(p).toContain("fix");
  });

  it("multiple check_suites coalesce: lists failed suite names, omits succeeded", () => {
    const events: Wire.WebhookEvent[] = [
      { id: "e1", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "failure", name: "CI / lint" } } },
      { id: "e2", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success", name: "CI / build" } } },
    ];
    const p = buildEventPrompt(events);
    expect(p).toContain("CI / lint");
    expect(p).not.toContain("CI / build");
  });

  it("review + inline comments coalesce into a single code-review prompt", () => {
    const events: Wire.WebhookEvent[] = [
      {
        id: "e1",
        name: "pull_request_review",
        payload: {
          pull_request: { number: 9 },
          review: { state: "changes_requested", body: "Overall looks wrong" },
        },
      },
      {
        id: "e2",
        name: "pull_request_review_comment",
        payload: {
          pull_request: { number: 9 },
          comment: { path: "src/foo.ts", body: "Fix this line", line: 42 },
        },
      },
    ];
    const p = buildEventPrompt(events);
    expect(p).not.toContain("Multiple events have happened");
    expect(p).toContain("PR #9");
    expect(p).toContain("Overall looks wrong");
    expect(p).toContain("src/foo.ts");
    expect(p).toContain("Fix this line");
  });
});

