import { describe, it, expect } from "vitest";
import { buildInitialPrompt, buildEventPrompt, fmtEventList, resolveEventTemplate, coalesceEvents, EVENT_FMT, formatCommentLocation, type EventTemplateFmtTable } from "../src/templates.js";
import type { GitHubEvent } from "../src/types.js";

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

  it("shared checkout — mentions worktree", () => {
    const p = buildInitialPrompt({
      number: 1, title: "T", body: "body", labels: [], repoUrl: "https://github.com/x/y",
    }, false);
    expect(p).toContain("worktree");
  });

});

describe("buildEventPrompt", () => {
  it("returns multi-event fallback for 2+ events", () => {
    const events: GitHubEvent[] = [
      { id: "e1", name: "issue_comment", payload: {} },
      { id: "e2", name: "pull_request_review", payload: {} },
    ];
    const p = buildEventPrompt(events);
    expect(p).toContain("Multiple events");
  });

  it("renders individual event prompts — no raw template literals", () => {
    const events: GitHubEvent[] = [
      { id: "e1", name: "issue_comment", payload: {} },
      { id: "e2", name: "pull_request_review", payload: {} },
    ];
    const p = buildEventPrompt(events);
    expect(p).not.toContain("${");
  });

  it("pull_request_review — contains PR number, review state, and body", () => {
    const evt: GitHubEvent = {
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
    const evt: GitHubEvent = {
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
    const events: GitHubEvent[] = [
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
    const evt: GitHubEvent = {
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
    const evt: GitHubEvent = { id: "e1", name: "deployment", payload: {} };
    const p = buildEventPrompt([evt]);
    expect(p).toBe("");
  });

  describe("pull_request/closed", () => {
    it("merged PR — includes PR number and 'merged'", () => {
      const evt: GitHubEvent = {
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
      const evt: GitHubEvent = {
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
    const events: GitHubEvent[] = [
      { id: "e1", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success", name: "CI" } } },
    ];
    const p = buildEventPrompt(events);
    expect(p).toContain("all tests passed");
    expect(p).toContain("wait");
  });
});

describe("fmtEventList", () => {
  it("formats a single event with action as name/action", () => {
    const events: GitHubEvent[] = [{ id: "e1", name: "check_suite", payload: { action: "completed" } }];
    expect(fmtEventList(events)).toBe("check_suite/completed");
  });

  it("formats a single event without action as just the name", () => {
    const events: GitHubEvent[] = [{ id: "e1", name: "deployment", payload: {} }];
    expect(fmtEventList(events)).toBe("deployment");
    expect(fmtEventList(events)).not.toContain("deployment/");
  });

  it("formats multiple events as comma-separated name/action pairs", () => {
    const events: GitHubEvent[] = [
      { id: "e1", name: "issue_comment", payload: { action: "created" } },
      { id: "e2", name: "check_suite", payload: { action: "completed" } },
    ];
    const result = fmtEventList(events);
    expect(result).toContain("issue_comment/created");
    expect(result).toContain("check_suite/completed");
  });
});

describe("resolveEventTemplate", () => {
  it("dispatches to the matching formatter", () => {
    const table: EventTemplateFmtTable = {
      push: () => "pushed!",
      _default: (_p, event) => `unknown: ${event.name}`,
    };
    const evt: GitHubEvent = { id: "e1", name: "push", payload: {} };
    expect(resolveEventTemplate(table, "push", evt)).toBe("pushed!");
  });

  it("falls back to _default when key is not in table", () => {
    const table: EventTemplateFmtTable = {
      _default: (_p, event) => `fallback: ${event.name}`,
    };
    const evt: GitHubEvent = { id: "e1", name: "delete", payload: {} };
    expect(resolveEventTemplate(table, "delete", evt)).toBe("fallback: delete");
  });

  it("returns empty string when key not in table and no _default", () => {
    const table: EventTemplateFmtTable = {
      push: () => "pushed!",
    };
    const evt: GitHubEvent = { id: "e1", name: "unknown", payload: {} };
    expect(resolveEventTemplate(table, "unknown", evt)).toBe("");
  });

  it("passes payload as first argument to formatter", () => {
    const table: EventTemplateFmtTable = {
      push: (p) => `ref: ${p.ref}`,
    };
    const evt: GitHubEvent = { id: "e1", name: "push", payload: { ref: "refs/heads/main" } };
    expect(resolveEventTemplate(table, "push", evt)).toBe("ref: refs/heads/main");
  });
});

describe("EVENT_FMT table", () => {
  it("check_suite action_required triggers failure message", () => {
    const evt: GitHubEvent = {
      id: "e1",
      name: "check_suite",
      payload: { check_suite: { conclusion: "action_required" } },
    };
    const result = EVENT_FMT.check_suite(evt.payload, evt);
    expect(result).toContain("action_required");
    expect(result).toContain("failing checks");
  });

  it("check_suite/completed success — prompts to verify merge-readiness", () => {
    const evt: GitHubEvent = {
      id: "e1",
      name: "check_suite",
      payload: { check_suite: { conclusion: "success" } },
    };
    const result = EVENT_FMT.check_suite(evt.payload, evt);
    expect(result).toContain("success");
  });

  it("pull_request/closed merged — instructs cleanup", () => {
    const evt: GitHubEvent = {
      id: "e1",
      name: "pull_request",
      payload: { action: "closed", pull_request: { number: 5, merged: true } },
    };
    const result = EVENT_FMT.pull_request(evt.payload, evt);
    expect(result).toContain("merged");
    expect(result).toContain("PR #5");
  });

  it("pull_request/closed — instructs worker to delete the branch", () => {
    const evt: GitHubEvent = {
      id: "e1",
      name: "pull_request",
      payload: { action: "closed", pull_request: { number: 5, merged: true } },
    };
    const result = EVENT_FMT.pull_request(evt.payload, evt);
    expect(result).toContain("delete the local branch");
  });

  it("pull_request/closed not merged — asks how to proceed", () => {
    const evt: GitHubEvent = {
      id: "e1",
      name: "pull_request",
      payload: { action: "closed", pull_request: { number: 7, merged: false } },
    };
    const result = EVENT_FMT.pull_request(evt.payload, evt);
    expect(result).toContain("closed without merging");
  });

  it("pull_request/closed — instructs to use skills for general practices", () => {
    const evt: GitHubEvent = {
      id: "e1",
      name: "pull_request",
      payload: { action: "closed", pull_request: { number: 5, merged: true } },
    };
    const result = EVENT_FMT.pull_request(evt.payload, evt);
    expect(result).toContain("skills");
    expect(result).toContain("general practices");
  });

  it("pull_request/closed — instructs to use CLAUDE.md for project-specific conventions", () => {
    const evt: GitHubEvent = {
      id: "e1",
      name: "pull_request",
      payload: { action: "closed", pull_request: { number: 5, merged: true } },
    };
    const result = EVENT_FMT.pull_request(evt.payload, evt);
    expect(result).toContain("CLAUDE.md");
    expect(result).toContain("project-specific");
  });

  it("pull_request/closed — warns not to use project memories", () => {
    const evt: GitHubEvent = {
      id: "e1",
      name: "pull_request",
      payload: { action: "closed", pull_request: { number: 5, merged: true } },
    };
    const result = EVENT_FMT.pull_request(evt.payload, evt);
    expect(result).toContain("memories");
    expect(result).toMatch(/not|do not|don't/i);
    expect(result).toContain("persist");
  });
});

describe("pull_request/auto_merge_enabled", () => {
  it("includes PR number and branch-review instruction", () => {
    const evt: GitHubEvent = {
      id: "e1",
      name: "pull_request",
      payload: {
        action: "auto_merge_enabled",
        pull_request: { number: 42 },
      },
    };
    const result = EVENT_FMT.pull_request(evt.payload, evt);
    expect(result).toContain("PR #42");
    expect(result).toContain("Auto-merge was enabled");
    expect(result).toContain("check if the branch is up to date");
    expect(result).toContain("do not merge yourself");
  });

  it("returns empty string for other pull_request actions", () => {
    const evt: GitHubEvent = {
      id: "e1",
      name: "pull_request",
      payload: { action: "labeled", pull_request: { number: 1 } },
    };
    expect(EVENT_FMT.pull_request(evt.payload, evt)).toBe("");
  });
});

describe("coalesceEvents", () => {
  it("multiple failing check suites → one _check_suites event with status: failed listing only failed names", () => {
    const events: GitHubEvent[] = [
      { id: "e1", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "failure", name: "CI / test" } } },
      { id: "e2", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "failure", name: "CI / lint" } } },
    ];
    const result = coalesceEvents(events);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("_check_suites");
    expect(result[0].payload.status).toBe("failed");
    expect(result[0].payload.failed).toEqual(["CI / test", "CI / lint"]);
    expect(result[0].payload.succeeded).toEqual([]);
  });

  it("multiple passing check suites → one _check_suites event with status: succeeded listing all names", () => {
    const events: GitHubEvent[] = [
      { id: "e1", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success", name: "CI / test" } } },
      { id: "e2", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success", name: "CI / lint" } } },
    ];
    const result = coalesceEvents(events);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("_check_suites");
    expect(result[0].payload.status).toBe("succeeded");
    expect(result[0].payload.failed).toEqual([]);
    expect(result[0].payload.succeeded).toEqual(["CI / test", "CI / lint"]);
  });

  it("mixed failing + passing check suites → status: failed, only failed names in failed array", () => {
    const events: GitHubEvent[] = [
      { id: "e1", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "failure", name: "CI / test" } } },
      { id: "e2", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success", name: "CI / lint" } } },
    ];
    const result = coalesceEvents(events);
    expect(result).toHaveLength(1);
    expect(result[0].payload.status).toBe("failed");
    expect(result[0].payload.failed).toEqual(["CI / test"]);
    expect(result[0].payload.succeeded).toEqual(["CI / lint"]);
  });

  it("single check suite → still coalesced into _check_suites for consistent rendering", () => {
    const events: GitHubEvent[] = [
      { id: "e1", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success", name: "CI" } } },
    ];
    const result = coalesceEvents(events);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("_check_suites");
  });

  it("check suite uses app.name when name is absent", () => {
    const events: GitHubEvent[] = [
      { id: "e1", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success", app: { name: "GitHub Actions" } } } },
    ];
    const result = coalesceEvents(events);
    expect(result[0].payload.succeeded).toEqual(["GitHub Actions"]);
  });

  it("review + review comments → _code_review event with comments array", () => {
    const events: GitHubEvent[] = [
      { id: "e1", name: "pull_request_review", payload: { pull_request: { number: 5 }, review: { state: "changes_requested", body: "Please fix" } } },
      { id: "e2", name: "pull_request_review_comment", payload: { pull_request: { number: 5 }, comment: { path: "src/foo.ts", body: "This is wrong" } } },
    ];
    const result = coalesceEvents(events);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("_code_review");
    expect(result[0].payload.pull_request).toEqual({ number: 5 });
    expect(result[0].payload.review).toEqual({ state: "changes_requested", body: "Please fix" });
    expect(result[0].payload.comments).toEqual([
      { path: "src/foo.ts", body: "This is wrong", line: undefined, startLine: undefined },
    ]);
  });

  it("review alone → _code_review with empty comments array", () => {
    const events: GitHubEvent[] = [
      { id: "e1", name: "pull_request_review", payload: { pull_request: { number: 5 }, review: { state: "approved", body: "" } } },
    ];
    const result = coalesceEvents(events);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("_code_review");
    expect(result[0].payload.comments).toEqual([]);
  });

  it("review comment with line number → included in coalesced comments", () => {
    const events: GitHubEvent[] = [
      {
        id: "e1",
        name: "pull_request_review_comment",
        payload: {
          pull_request: { number: 5 },
          comment: { path: "src/foo.ts", body: "Rename this", line: 42, start_line: null },
        },
      },
    ];
    const result = coalesceEvents(events);
    expect(result[0].payload.comments).toEqual([
      { path: "src/foo.ts", body: "Rename this", line: 42, startLine: null },
    ]);
  });

  it("review comment with line range → both line and startLine included", () => {
    const events: GitHubEvent[] = [
      {
        id: "e1",
        name: "pull_request_review_comment",
        payload: {
          pull_request: { number: 5 },
          comment: { path: "src/bar.ts", body: "Extract this", line: 15, start_line: 10 },
        },
      },
    ];
    const result = coalesceEvents(events);
    expect(result[0].payload.comments).toEqual([
      { path: "src/bar.ts", body: "Extract this", line: 15, startLine: 10 },
    ]);
  });

  it("mixed types (check suites + issue_comment) → both preserved", () => {
    const events: GitHubEvent[] = [
      { id: "e1", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success", name: "CI" } } },
      { id: "e2", name: "issue_comment", payload: { issue: { number: 1 }, comment: { body: "LGTM" } } },
    ];
    const result = coalesceEvents(events);
    expect(result.some(e => e.name === "issue_comment")).toBe(true);
    expect(result.some(e => e.name === "_check_suites")).toBe(true);
    expect(result).toHaveLength(2);
  });
});

describe("buildEventPrompt — pipeline behavior", () => {
  it("single event → no 'Multiple events have happened' prefix", () => {
    const events: GitHubEvent[] = [
      { id: "e1", name: "issue_comment", payload: { issue: { number: 1 }, comment: { body: "hello" } } },
    ];
    const p = buildEventPrompt(events);
    expect(p).not.toContain("Multiple events have happened");
  });

  it("multiple events after coalescing → 'Multiple events have happened:' prefix", () => {
    const events: GitHubEvent[] = [
      { id: "e1", name: "issue_comment", payload: { issue: { number: 1 }, comment: { body: "hello" } } },
      { id: "e2", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success", name: "CI" } } },
    ];
    const p = buildEventPrompt(events);
    expect(p).toContain("Multiple events have happened:");
  });

  it("multiple check suites coalesce to one → no 'Multiple events' prefix", () => {
    const events: GitHubEvent[] = [
      { id: "e1", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success", name: "CI / test" } } },
      { id: "e2", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success", name: "CI / lint" } } },
    ];
    const p = buildEventPrompt(events);
    expect(p).not.toContain("Multiple events have happened");
  });

  it("multiple events → joined with separator", () => {
    const events: GitHubEvent[] = [
      { id: "e1", name: "issue_comment", payload: { issue: { number: 1 }, comment: { body: "hello" } } },
      { id: "e2", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success", name: "CI" } } },
    ];
    const p = buildEventPrompt(events);
    expect(p).toContain("---");
  });

  it("issue_comment sorts before _check_suites in multi-event output", () => {
    const events: GitHubEvent[] = [
      { id: "e1", name: "check_suite", payload: { action: "completed", check_suite: { conclusion: "success", name: "CI" } } },
      { id: "e2", name: "issue_comment", payload: { issue: { number: 1 }, comment: { body: "UAT comment" } } },
    ];
    const p = buildEventPrompt(events);
    const commentIdx = p.indexOf("UAT comment");
    const checkIdx = p.indexOf("Checks succeeded");
    expect(commentIdx).toBeLessThan(checkIdx);
  });
});

describe("EVENT_FMT — new entries", () => {
  it("_check_suites with failures → lists only failed suite names and instructs to fix", () => {
    const evt: GitHubEvent = {
      id: "e1",
      name: "_check_suites",
      payload: { status: "failed", failed: ["CI / test", "CI / lint"], succeeded: ["CI / build"] },
    };
    const result = EVENT_FMT._check_suites(evt.payload, evt);
    expect(result).toContain("Checks have failed");
    expect(result).toContain("CI / test");
    expect(result).toContain("CI / lint");
    expect(result).not.toContain("CI / build");
    expect(result).toContain("review the failing checks");
  });

  it("_check_suites all succeeded → lists all suite names and instructs to verify merge-readiness", () => {
    const evt: GitHubEvent = {
      id: "e1",
      name: "_check_suites",
      payload: { status: "succeeded", failed: [], succeeded: ["CI / test", "CI / build"] },
    };
    const result = EVENT_FMT._check_suites(evt.payload, evt);
    expect(result).toContain("Checks succeeded");
    expect(result).toContain("CI / test");
    expect(result).toContain("CI / build");
    expect(result).toContain("PR can be merged");
  });

  it("_check_suites succeeded prompt ends with branch-review instruction", () => {
    const evt: GitHubEvent = {
      id: "e1",
      name: "_check_suites",
      payload: { status: "succeeded", failed: [], succeeded: ["CI"] },
    };
    const result = EVENT_FMT._check_suites(evt.payload, evt);
    expect(result).toContain("check if the branch is up to date");
    expect(result).toContain("do not merge yourself");
  });

  it("check_suite success prompt ends with branch-review instruction", () => {
    const evt: GitHubEvent = {
      id: "e1",
      name: "check_suite",
      payload: { check_suite: { conclusion: "success" } },
    };
    const result = EVENT_FMT.check_suite(evt.payload, evt);
    expect(result).toContain("check if the branch is up to date");
    expect(result).toContain("do not merge yourself");
  });

  it("_code_review renders PR number, review state, body, and inline comments", () => {
    const evt: GitHubEvent = {
      id: "e1",
      name: "_code_review",
      payload: {
        pull_request: { number: 5 },
        review: { state: "changes_requested", body: "Please fix the issue" },
        comments: [{ path: "src/foo.ts", body: "This line is wrong" }],
      },
    };
    const result = EVENT_FMT._code_review(evt.payload, evt);
    expect(result).toContain("PR #5");
    expect(result).toContain("changes_requested");
    expect(result).toContain("Please fix the issue");
    expect(result).toContain("src/foo.ts");
    expect(result).toContain("This line is wrong");
  });

  it("_code_review with no comments renders without error", () => {
    const evt: GitHubEvent = {
      id: "e1",
      name: "_code_review",
      payload: {
        pull_request: { number: 3 },
        review: { state: "approved", body: "LGTM" },
        comments: [],
      },
    };
    const result = EVENT_FMT._code_review(evt.payload, evt);
    expect(result).toContain("PR #3");
    expect(result).toContain("approved");
    expect(result).toContain("LGTM");
  });

  it("_code_review inline comment with line number → includes 'line N' in output", () => {
    const evt: GitHubEvent = {
      id: "e1",
      name: "_code_review",
      payload: {
        pull_request: { number: 5 },
        review: { state: "changes_requested", body: "" },
        comments: [{ path: "src/foo.ts", body: "Rename this", line: 42, startLine: null }],
      },
    };
    const result = EVENT_FMT._code_review(evt.payload, evt);
    expect(result).toContain("`src/foo.ts` line 42");
  });

  it("_code_review inline comment with line range → includes 'lines N-M' in output", () => {
    const evt: GitHubEvent = {
      id: "e1",
      name: "_code_review",
      payload: {
        pull_request: { number: 5 },
        review: { state: "changes_requested", body: "" },
        comments: [{ path: "src/bar.ts", body: "Extract this", line: 15, startLine: 10 }],
      },
    };
    const result = EVENT_FMT._code_review(evt.payload, evt);
    expect(result).toContain("`src/bar.ts` lines 10-15");
  });

  it("_code_review inline comment with no line → just shows path (file-level)", () => {
    const evt: GitHubEvent = {
      id: "e1",
      name: "_code_review",
      payload: {
        pull_request: { number: 5 },
        review: { state: "changes_requested", body: "" },
        comments: [{ path: "src/baz.ts", body: "General comment", line: null, startLine: null }],
      },
    };
    const result = EVENT_FMT._code_review(evt.payload, evt);
    expect(result).toContain("`src/baz.ts`: General comment");
  });
});

describe("formatCommentLocation", () => {
  it("file-level comment (no line) → just backtick-path", () => {
    const result = formatCommentLocation("src/foo.ts");
    expect(result).toBe("`src/foo.ts`");
  });

  it("single-line comment → path line N", () => {
    const result = formatCommentLocation("src/foo.ts", 42);
    expect(result).toBe("`src/foo.ts` line 42");
  });

  it("multi-line comment → path lines N-M", () => {
    const result = formatCommentLocation("src/foo.ts", 15, 10);
    expect(result).toBe("`src/foo.ts` lines 10-15");
  });

  it("start_line equals line → treated as single line", () => {
    const result = formatCommentLocation("src/foo.ts", 42, 42);
    expect(result).toBe("`src/foo.ts` line 42");
  });

  it("null line → just backtick-path", () => {
    const result = formatCommentLocation("src/foo.ts", null);
    expect(result).toBe("`src/foo.ts`");
  });
});

