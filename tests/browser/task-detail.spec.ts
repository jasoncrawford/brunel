/**
 * Browser tests for the task detail page (/tasks/:id).
 *
 * Verifies that navigating to a task's page shows the correct heading and
 * that live WebSocket events (broadcast by the foreman when webhooks arrive)
 * appear in the event history table.
 */
import { test, expect } from "@playwright/test";

function makeTaskEvents(startId: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    kind: "webhook",
    id: startId + i,
    timestamp: new Date(Date.now() - (startId + i) * 1000).toISOString(),
    taskId: "pg-task",
    workerId: null,
    summary: `task-event-${startId + i}`,
  }));
}

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
    repository: { full_name: "owner/repo" },
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
    repository: { full_name: "owner/repo" },
  });

  // Set up admin WS listener BEFORE navigating — same pattern as worker-detail
  // test 2, since TaskDetail only handles live log_events (not initial_log).
  const adminWsReady = page.waitForEvent("websocket", (ws) =>
    ws.url().includes("/admin/ws"),
  );

  // Navigate to the task detail page and wait for the WS to connect
  await page.goto("/tasks/5001");

  const adminWs = await adminWsReady;
  // Wait for the initial snapshot/log frame to confirm the WS is open and ready
  await adminWs.waitForEvent("framereceived", { timeout: 5000 });

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
    repository: { full_name: "owner/repo" },
    sender: { login: "reviewer" },
  });

  // The event should appear in the events table on the task detail page
  // fmtEvent for issue_comment/created with body "LGTM":
  // "issue_comment/created — "LGTM""
  await expect(page.getByText(/issue_comment\/created/).first()).toBeVisible();
});

test("task detail: appends next page and removes load-more after last page", async ({ page }) => {
  const PAGE_SIZE = 50;

  await page.route("**/api/tasks/pg-task/events**", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      json: url.searchParams.has("before")
        ? makeTaskEvents(PAGE_SIZE, 5)
        : makeTaskEvents(0, PAGE_SIZE),
    });
  });
  await page.route("**/api/tasks/pg-task", async (route) => {
    await route.fulfill({ json: { taskId: "pg-task", title: "Pagination test task", status: "pending" } });
  });

  await page.goto("/tasks/pg-task");
  await expect(page.getByText("task-event-0")).toBeVisible();

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

  await expect(page.getByText(`task-event-${PAGE_SIZE}`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more" })).not.toBeVisible();
});

test("task detail: passes before cursor from last entry of current page", async ({ page }) => {
  const PAGE_SIZE = 50;
  const firstPage = makeTaskEvents(0, PAGE_SIZE);
  const expectedCursor = firstPage[firstPage.length - 1].timestamp;

  let capturedBefore: string | null = null;
  await page.route("**/api/tasks/pg-task/events**", async (route) => {
    const url = new URL(route.request().url());
    const before = url.searchParams.get("before");
    if (before) capturedBefore = before;
    await route.fulfill({ json: before ? makeTaskEvents(PAGE_SIZE, 3) : firstPage });
  });
  await page.route("**/api/tasks/pg-task", async (route) => {
    await route.fulfill({ json: { taskId: "pg-task", title: "Pagination test task", status: "pending" } });
  });

  await page.goto("/tasks/pg-task");
  await expect(page.getByText("task-event-0")).toBeVisible();

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

  await expect(page.getByText(`task-event-${PAGE_SIZE}`)).toBeVisible();
  expect(capturedBefore).toBe(expectedCursor);
});
