import { describe, it, expect, vi, afterEach } from "vitest";
import { buildInitialPrompt, buildEventPrompt, resolveEventTemplate, EVENT_FMT, type EventTemplateFmtTable } from "../src/templates.js";
import type { GitHubEvent } from "../src/types.js";
import { stripAnsi } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

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
      { id: "e1", name: "check_run", payload: {} },
      { id: "e2", name: "pull_request_review", payload: {} },
    ];
    const p = buildEventPrompt(events);
    expect(p).toContain("Multiple events");
  });

  it("lists event names in multi-event fallback", () => {
    const events: GitHubEvent[] = [
      { id: "e1", name: "check_run", payload: {} },
      { id: "e2", name: "pull_request_review", payload: {} },
    ];
    const p = buildEventPrompt(events);
    expect(p).toContain("check_run");
    expect(p).toContain("pull_request_review");
    expect(p).not.toContain("${");
  });

  describe("check_run", () => {
    it("contains check name and summary on failure", () => {
      const evt: GitHubEvent = {
        id: "e1",
        name: "check_run",
        payload: {
          check_run: {
            name: "unit-tests",
            conclusion: "failure",
            output: { summary: "5 tests failed" },
          },
        },
      };
      const p = buildEventPrompt([evt]);
      expect(p).toContain("unit-tests");
      expect(p).toContain("failure");
      expect(p).toContain("5 tests failed");
    });

    it("produces a different (non-failure) message on success", () => {
      const failEvt: GitHubEvent = {
        id: "e1",
        name: "check_run",
        payload: {
          check_run: {
            name: "unit-tests",
            conclusion: "failure",
            output: { summary: "5 tests failed" },
          },
        },
      };
      const successEvt: GitHubEvent = {
        id: "e2",
        name: "check_run",
        payload: {
          check_run: {
            name: "unit-tests",
            conclusion: "success",
            output: { summary: "All tests passed" },
          },
        },
      };
      const failPrompt = buildEventPrompt([failEvt]);
      const successPrompt = buildEventPrompt([successEvt]);
      expect(successPrompt).toContain("unit-tests");
      expect(successPrompt).toContain("success");
      expect(successPrompt).not.toBe(failPrompt);
    });
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

  it("unknown event type — returns a fallback message mentioning the event name", () => {
    const evt: GitHubEvent = { id: "e1", name: "deployment", payload: {} };
    const p = buildEventPrompt([evt]);
    expect(p).toContain("deployment");
  });

  describe("diagnostic logging", () => {
    it("logs 'Building prompt from events:' before building", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const evt: GitHubEvent = { id: "e1", name: "check_suite", payload: { action: "completed" } };
      buildEventPrompt([evt]);
      const calls = consoleSpy.mock.calls.map(args => stripAnsi(String(args[0])));
      expect(calls.some(s => s.startsWith("Building prompt from events:"))).toBe(true);
    });

    it("logs event name/action in building message", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const evt: GitHubEvent = { id: "e1", name: "check_suite", payload: { action: "completed" } };
      buildEventPrompt([evt]);
      const calls = consoleSpy.mock.calls.map(args => stripAnsi(String(args[0])));
      const buildingLine = calls.find(s => s.startsWith("Building prompt from events:"));
      expect(buildingLine).toContain("check_suite/completed");
    });

    it("logs multiple events as comma-separated name/action pairs in building message", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const events: GitHubEvent[] = [
        { id: "e1", name: "check_run", payload: { action: "completed" } },
        { id: "e2", name: "check_suite", payload: { action: "completed" } },
      ];
      buildEventPrompt(events);
      const calls = consoleSpy.mock.calls.map(args => stripAnsi(String(args[0])));
      const buildingLine = calls.find(s => s.startsWith("Building prompt from events:"));
      expect(buildingLine).toContain("check_run/completed");
      expect(buildingLine).toContain("check_suite/completed");
    });

    it("logs event name without action when payload has no action", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const evt: GitHubEvent = { id: "e1", name: "deployment", payload: {} };
      buildEventPrompt([evt]);
      const calls = consoleSpy.mock.calls.map(args => stripAnsi(String(args[0])));
      const buildingLine = calls.find(s => s.startsWith("Building prompt from events:"));
      expect(buildingLine).toContain("deployment");
      expect(buildingLine).not.toContain("deployment/");
    });

    it("logs the built prompt after building", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const evt: GitHubEvent = {
        id: "e1",
        name: "issue_comment",
        payload: { issue: { number: 5 }, comment: { body: "Hello there" } },
      };
      const prompt = buildEventPrompt([evt]);
      const calls = consoleSpy.mock.calls.map(args => String(args[0]));
      expect(calls.some(s => s.includes(prompt))).toBe(true);
    });
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

  it("passes payload as first argument to formatter", () => {
    const table: EventTemplateFmtTable = {
      push: (p) => `ref: ${p.ref}`,
    };
    const evt: GitHubEvent = { id: "e1", name: "push", payload: { ref: "refs/heads/main" } };
    expect(resolveEventTemplate(table, "push", evt)).toBe("ref: refs/heads/main");
  });
});

describe("EVENT_FMT table", () => {
  it("check_run action_required triggers failure message", () => {
    const evt: GitHubEvent = {
      id: "e1",
      name: "check_run",
      payload: {
        check_run: { name: "lint", conclusion: "action_required", output: { summary: "Action needed" } },
      },
    };
    const result = EVENT_FMT.check_run(evt.payload, evt);
    expect(result).toContain("lint");
    expect(result).toContain("action_required");
    expect(result).toContain("Action needed");
  });

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

  it("_default includes event name", () => {
    const evt: GitHubEvent = { id: "e1", name: "workflow_run", payload: {} };
    const result = EVENT_FMT._default(evt.payload, evt);
    expect(result).toContain("workflow_run");
  });
});
