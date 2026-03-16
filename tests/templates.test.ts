import { describe, it, expect } from "vitest";
import { buildInitialPrompt, buildEventPrompt } from "../src/templates.js";
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
      { id: "e1", name: "check_run", payload: {} },
      { id: "e2", name: "pull_request_review", payload: {} },
    ];
    const p = buildEventPrompt(events);
    expect(p).toContain("Multiple events");
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
});
