/**
 * Tests for formatForemanMessage — the function that maps each ForemanMessage
 * to a display string (or null if the message type handles its own printing).
 *
 * This covers the bug in issue #55: event_notification messages were received
 * silently by the worker with nothing printed to the console.
 */
import { describe, it, expect } from "vitest";
import { formatForemanMessage } from "../src/display.js";
import type { ForemanMessage } from "../src/types.js";

const baseEvent = {
  id: "evt-1",
  name: "issues",
  payload: {
    action: "labeled",
    label: { name: "brunel:ready" },
    issue: { number: 42, title: "Fix the bug" },
    sender: { login: "alice" },
    repository: { full_name: "owner/repo" },
  },
};

describe("formatForemanMessage", () => {
  it("returns a one-line string for event_notification", () => {
    const msg: ForemanMessage = {
      type: "event_notification",
      taskId: "42",
      event: baseEvent,
    };
    const text = formatForemanMessage(msg);
    expect(text).not.toBeNull();
    expect(text).not.toContain("\n");
  });

  it("event_notification string includes event name", () => {
    const msg: ForemanMessage = {
      type: "event_notification",
      taskId: "42",
      event: baseEvent,
    };
    const text = formatForemanMessage(msg)!;
    expect(text).toContain("issues");
  });

  it("event_notification string includes issue number", () => {
    const msg: ForemanMessage = {
      type: "event_notification",
      taskId: "42",
      event: baseEvent,
    };
    const text = formatForemanMessage(msg)!;
    expect(text).toMatch(/#42/);
  });

  it("event_notification works for non-issue events (e.g. push)", () => {
    const msg: ForemanMessage = {
      type: "event_notification",
      taskId: "1",
      event: {
        id: "evt-2",
        name: "push",
        payload: {
          ref: "refs/heads/main",
          commits: [{}],
          repository: { full_name: "owner/repo" },
          sender: { login: "bob" },
        },
      },
    };
    const text = formatForemanMessage(msg);
    expect(text).not.toBeNull();
    expect(text).not.toContain("\n");
    expect(text).toContain("push");
  });

  it("returns null for task_assigned (printed later in the task flow)", () => {
    const msg: ForemanMessage = {
      type: "task_assigned",
      taskId: "1",
      issue: { number: 1, title: "Fix bug", body: "", labels: [], repoUrl: "" },
    };
    expect(formatForemanMessage(msg)).toBeNull();
  });

  it("returns null for standby (printed inline in the handler)", () => {
    const msg: ForemanMessage = { type: "standby" };
    expect(formatForemanMessage(msg)).toBeNull();
  });
});
