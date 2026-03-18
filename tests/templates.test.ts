import { describe, it, expect } from "vitest";
import { buildInitialPrompt, buildEventPrompt, fmtEventList, resolveEventTemplate, EVENT_FMT, type EventTemplateFmtTable } from "../src/templates.js";
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
    });
    expect(p).toContain("bug");
    expect(p).toContain("help wanted");
    expect(p).toContain("brunel:ready");
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

  it("lists event names in multi-event fallback", () => {
    const events: GitHubEvent[] = [
      { id: "e1", name: "issue_comment", payload: {} },
      { id: "e2", name: "pull_request_review", payload: {} },
    ];
    const p = buildEventPrompt(events);
    expect(p).toContain("issue_comment");
    expect(p).toContain("pull_request_review");
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

  it("pull_request/closed — instructs worker to clean up its worktree", () => {
    const evt: GitHubEvent = {
      id: "e1",
      name: "pull_request",
      payload: { action: "closed", pull_request: { number: 5, merged: true } },
    };
    const result = EVENT_FMT.pull_request(evt.payload, evt);
    expect(result).toContain("worktree");
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
});
