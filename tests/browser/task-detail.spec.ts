/**
 * Browser tests for the task detail page (/tasks/:id).
 *
 * Verifies that navigating to a task's page shows the correct heading and
 * that live WebSocket events (broadcast by the foreman when webhooks arrive)
 * appear in the event history table.
 */
import { test, expect } from "@playwright/test";

const BASE = "http://localhost:14567";

async function postWebhook(name: string, payload: object): Promise<void> {
  const res = await fetch(`${BASE}/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-github-event": name,
      "x-github-delivery": `test-${Date.now()}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Webhook POST failed: ${res.status}`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("task detail page: shows correct task ID in heading", async ({ page }) => {
  // Create issue #4001 via a real webhook so the full ingestion pipeline runs
  await postWebhook("issues", {
    action: "labeled",
    label: { name: "brunel:ready" },
    issue: {
      number: 4001,
      title: "Task detail heading test",
      body: "",
      labels: [{ name: "brunel:ready" }],
    },
    repository: { html_url: "https://github.com/test/repo" },
  });

  await page.goto("/tasks/4001");

  await expect(page.getByRole("heading", { name: /Task #4001/ })).toBeVisible();
});

test("task detail page: live events appear as webhooks arrive for that task", async ({
  page,
}) => {
  // Create issue #5001
  await postWebhook("issues", {
    action: "labeled",
    label: { name: "brunel:ready" },
    issue: {
      number: 5001,
      title: "Task detail live events test",
      body: "",
      labels: [{ name: "brunel:ready" }],
    },
    repository: { html_url: "https://github.com/test/repo" },
  });

  // Navigate to the task detail page and wait for the WS to connect
  await page.goto("/tasks/5001");

  // Fire another webhook for this task (an issue comment event)
  // The foreman routes it to the task and broadcasts it as a log_event
  // with taskId="5001". The task detail page listens for these events.
  await postWebhook("issue_comment", {
    action: "created",
    issue: {
      number: 5001,
      title: "Task detail live events test",
    },
    comment: {
      body: "LGTM",
    },
    repository: { full_name: "test/repo" },
    sender: { login: "reviewer" },
  });

  // The event should appear in the events table on the task detail page
  // fmtEvent for issue_comment/created with body "LGTM":
  // "issue_comment/created — "LGTM""
  await expect(page.getByText(/issue_comment/)).toBeVisible();
});
