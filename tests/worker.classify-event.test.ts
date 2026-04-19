import { describe, it, expect } from "vitest";
import { classifyEvent } from "../src/agent/controllers/worker-controller.js";
import * as Wire from "../shared/wire.js";

function makeEvent(name: string, payload: Record<string, unknown> = {}): Wire.WebhookEvent {
  return { id: "evt-1", name, payload };
}

describe("classifyEvent", () => {
  describe("check_run", () => {
    it("is always log_only", () => {
      expect(classifyEvent(makeEvent("check_run", { action: "completed" }))).toBe("log_only");
      expect(classifyEvent(makeEvent("check_run", { action: "created" }))).toBe("log_only");
    });
  });

  describe("check_suite", () => {
    it("is log_only when action is not completed", () => {
      expect(classifyEvent(makeEvent("check_suite", { action: "requested" }))).toBe("log_only");
      expect(classifyEvent(makeEvent("check_suite", { action: "rerequested" }))).toBe("log_only");
    });

    it("is log_only when completed with conclusion skipped", () => {
      expect(classifyEvent(makeEvent("check_suite", {
        action: "completed",
        check_suite: { conclusion: "skipped" },
      }))).toBe("log_only");
    });

    it("is actionable when completed with conclusion success", () => {
      expect(classifyEvent(makeEvent("check_suite", {
        action: "completed",
        check_suite: { conclusion: "success" },
      }))).toBe("actionable");
    });

    it("is actionable when completed with conclusion failure", () => {
      expect(classifyEvent(makeEvent("check_suite", {
        action: "completed",
        check_suite: { conclusion: "failure" },
      }))).toBe("actionable");
    });

    it("is actionable when completed with conclusion action_required", () => {
      expect(classifyEvent(makeEvent("check_suite", {
        action: "completed",
        check_suite: { conclusion: "action_required" },
      }))).toBe("actionable");
    });

    it("is actionable when completed with null conclusion (no check_suite field)", () => {
      expect(classifyEvent(makeEvent("check_suite", {
        action: "completed",
      }))).toBe("actionable");
    });
  });

  describe("pull_request", () => {
    it("is actionable when action is closed", () => {
      expect(classifyEvent(makeEvent("pull_request", { action: "closed" }))).toBe("actionable");
    });

    it("is actionable when action is auto_merge_enabled", () => {
      expect(classifyEvent(makeEvent("pull_request", { action: "auto_merge_enabled" }))).toBe("actionable");
    });

    it("is log_only when action is opened", () => {
      expect(classifyEvent(makeEvent("pull_request", { action: "opened" }))).toBe("log_only");
    });

    it("is log_only when action is synchronize", () => {
      expect(classifyEvent(makeEvent("pull_request", { action: "synchronize" }))).toBe("log_only");
    });

    it("is log_only when action is reopened", () => {
      expect(classifyEvent(makeEvent("pull_request", { action: "reopened" }))).toBe("log_only");
    });
  });

  describe("pull_request_review", () => {
    it("is always actionable", () => {
      expect(classifyEvent(makeEvent("pull_request_review", { action: "submitted" }))).toBe("actionable");
      expect(classifyEvent(makeEvent("pull_request_review", { action: "dismissed" }))).toBe("actionable");
    });
  });

  describe("pull_request_review_comment", () => {
    it("is always actionable", () => {
      expect(classifyEvent(makeEvent("pull_request_review_comment", { action: "created" }))).toBe("actionable");
    });
  });

  describe("issue_comment", () => {
    it("is actionable for a normal comment body", () => {
      expect(classifyEvent(makeEvent("issue_comment", {
        action: "created",
        comment: { body: "Please take a look at this." },
      }))).toBe("actionable");
    });

    it("is log_only when body starts with <!-- railway-bot-comment", () => {
      expect(classifyEvent(makeEvent("issue_comment", {
        action: "created",
        comment: { body: "<!-- railway-bot-comment -->Some automated message" },
      }))).toBe("log_only");
    });

    it("is actionable when comment field is missing", () => {
      expect(classifyEvent(makeEvent("issue_comment", { action: "created" }))).toBe("actionable");
    });
  });

  describe("unknown event names", () => {
    it("is log_only for push", () => {
      expect(classifyEvent(makeEvent("push"))).toBe("log_only");
    });

    it("is log_only for create", () => {
      expect(classifyEvent(makeEvent("create"))).toBe("log_only");
    });

    it("is log_only for an unrecognised event", () => {
      expect(classifyEvent(makeEvent("some_future_event"))).toBe("log_only");
    });
  });
});
