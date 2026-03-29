/**
 * Browser tests for the admin dashboard (/).
 *
 * Each test seeds state via real POST /webhook payloads so the full ingestion
 * pipeline runs — the same path GitHub uses in production.  A mock worker is
 * connected/disconnected through the /test/* test-only endpoints exposed by
 * the browser test server.
 *
 * Issue numbers and worker IDs are unique per test to avoid cross-test
 * interference (the server is shared across the whole suite).
 */
import { test, expect } from "@playwright/test";

const BASE = "http://localhost:14567";

/** POST a GitHub-style webhook payload to the foreman's /webhook endpoint. */
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

/** Connect a mock idle worker via the test endpoint; returns its workerId. */
async function connectWorker(): Promise<string> {
  const res = await fetch(`${BASE}/test/connect-worker`, { method: "POST" });
  if (!res.ok) throw new Error(`connect-worker failed: ${res.status}`);
  const { workerId } = (await res.json()) as { workerId: string };
  return workerId;
}

/** Disconnect a mock worker via the test endpoint. */
async function disconnectWorker(workerId: string): Promise<void> {
  await fetch(`${BASE}/test/workers/${workerId}`, { method: "DELETE" });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("initial load: task list and worker list are visible", async ({ page }) => {
  // Seed: create issue #1001
  await postWebhook("issues", {
    action: "labeled",
    label: { name: "brunel:ready" },
    issue: {
      number: 1001,
      title: "Dashboard initial load test",
      body: "",
      labels: [{ name: "brunel:ready" }],
    },
    repository: { html_url: "https://github.com/test/repo" },
  });

  // Seed: connect an idle worker so the workers section is non-empty
  const workerId = await connectWorker();

  try {
    await page.goto("/");

    // Task appears in the task table (the link may also appear in the Recent Events
    // log — use .first() to avoid strict-mode violations from multiple matches)
    await expect(page.getByRole("link", { name: "#1001" }).first()).toBeVisible();
    await expect(page.getByText("Dashboard initial load test")).toBeVisible();

    // Worker appears in the workers list — use href-based selector so the locator
    // is unique even when other workers share the same short prefix
    await expect(
      page.locator(`a[href="/workers/${workerId}"]`).first(),
    ).toBeVisible();
  } finally {
    await disconnectWorker(workerId);
  }
});

test("live task assignment: dashboard updates without page reload", async ({
  page,
}) => {
  await page.goto("/");

  // Connect an idle worker before the task exists
  const workerId = await connectWorker();

  try {
    // Verify the worker shows up as idle — use href-based selector to avoid
    // collisions with other workers that share the same short timestamp prefix
    await expect(
      page.locator(`a[href="/workers/${workerId}"]`).first(),
    ).toBeVisible();

    // Fire a webhook to create issue #2001 — after depsLoaded resolves the
    // task will be assigned to the idle worker
    await postWebhook("issues", {
      action: "labeled",
      label: { name: "brunel:ready" },
      issue: {
        number: 2001,
        title: "Live assignment test",
        body: "",
        labels: [{ name: "brunel:ready" }],
      },
      repository: { html_url: "https://github.com/test/repo" },
    });

    // Task row should appear and transition to "assigned" in real time.
    // Scope to the Tasks section so we don't accidentally match a Recent Events
    // row that also contains "#2001" (those rows appear earlier in real time, via
    // log_event, before the snapshot updates the task table, and don't have
    // "assigned" in their cells).
    const tasksSection = page
      .locator("section")
      .filter({ has: page.locator("h3").filter({ hasText: /Tasks/ }) });
    await expect(tasksSection.getByRole("link", { name: "#2001" })).toBeVisible();
    const taskRow = tasksSection.getByRole("row").filter({ hasText: "#2001" });
    await expect(taskRow.getByText("assigned")).toBeVisible();

    // Workers section header shows "1 busy" (or at least the worker item
    // contains "busy" next to the worker prefix)
    const workerItem = page
      .getByRole("listitem")
      .filter({ has: page.locator(`a[href="/workers/${workerId}"]`) });
    await expect(workerItem.getByText("busy")).toBeVisible();
  } finally {
    await disconnectWorker(workerId);
  }
});

test("log stream: webhook events appear in recent events with correct summaries", async ({
  page,
}) => {
  await page.goto("/");

  // Post a push event — fmtEvent produces: "push — 1 commits to refs/heads/main"
  await postWebhook("push", {
    ref: "refs/heads/main",
    commits: [{ id: "abc123" }],
    repository: { full_name: "test/repo" },
    sender: { login: "dev" },
  });

  // The Recent Events section on the dashboard should show the event
  // Use .first() in case prior tests also generated push events
  await expect(page.getByText(/push/).first()).toBeVisible();

  // Post an issues/labeled event — fmtEvent: "issues/labeled — label: brunel:ready"
  await postWebhook("issues", {
    action: "labeled",
    label: { name: "brunel:ready" },
    issue: {
      number: 3001,
      title: "Log stream test issue",
      body: "",
      labels: [{ name: "brunel:ready" }],
    },
    repository: { full_name: "test/repo" },
    sender: { login: "dev" },
  });

  // Both events should be present; use .first() since accumulated log state from
  // other tests may contain additional issues/labeled entries
  await expect(page.getByText(/issues\/labeled/).first()).toBeVisible();
  // Summary contains the label name produced by fmtEvent / fmtEventDetails
  await expect(page.getByText(/label: brunel:ready/).first()).toBeVisible();
});
