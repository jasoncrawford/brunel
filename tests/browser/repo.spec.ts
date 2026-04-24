/**
 * Browser tests for multi-repo dashboard features.
 *
 * Verifies that the repos section appears on the dashboard,
 * that the repo detail page shows repo-scoped tasks and workers,
 * and that task/worker detail pages show the repo.
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

async function connectWorker(): Promise<string> {
  const res = await fetch(`${BASE}/test/connect-worker`, { method: "POST" });
  if (!res.ok) throw new Error(`connect-worker failed: ${res.status}`);
  const { workerId } = (await res.json()) as { workerId: string };
  return workerId;
}

async function disconnectWorker(workerId: string): Promise<void> {
  await fetch(`${BASE}/test/workers/${workerId}`, { method: "DELETE" });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("dashboard: repos section shows active repo", async ({ page }) => {
  await page.goto("/");
  // The test server activates "owner/repo" at startup
  await expect(page.getByRole("heading", { name: /Repos/ })).toBeVisible();
  const reposSection = page.locator("section").filter({ has: page.locator("h3").filter({ hasText: /Repos/ }) });
  await expect(reposSection.getByRole("link", { name: "owner/repo" })).toBeVisible();
});

test("repo detail page: shows repo name and tasks", async ({ page }) => {
  // Seed a task for owner/repo
  await postWebhook("issues", {
    action: "labeled",
    label: { name: "brunel:ready" },
    issue: {
      number: 5001,
      title: "Repo detail test task",
      body: "",
      labels: [{ name: "brunel:ready" }],
    },
    repository: { full_name: "owner/repo" },
  });

  // Navigate to the dashboard and click the repo link in the Repos section
  await page.goto("/");
  const reposSection = page.locator("section").filter({ has: page.locator("h3").filter({ hasText: /Repos/ }) });
  await reposSection.getByRole("link", { name: "owner/repo" }).click();

  // Should be on a /repos/:id page showing the repo name
  await expect(page.getByRole("heading", { name: "owner/repo" })).toBeVisible();
  // The task should be visible
  await expect(page.getByRole("link", { name: "#5001" }).first()).toBeVisible();
  await expect(page.getByText("Repo detail test task")).toBeVisible();
});

test("repo detail page: shows workers for this repo", async ({ page }) => {
  const workerId = await connectWorker();

  try {
    await page.goto("/");
    const reposSection = page.locator("section").filter({ has: page.locator("h3").filter({ hasText: /Repos/ }) });
    await reposSection.getByRole("link", { name: "owner/repo" }).click();

    // Worker should appear in the workers section
    await expect(
      page.locator(`a[href="/workers/${workerId}"]`).first(),
    ).toBeVisible();
  } finally {
    await disconnectWorker(workerId);
  }
});

test("task detail page: shows repo info", async ({ page }) => {
  // Seed a task
  await postWebhook("issues", {
    action: "labeled",
    label: { name: "brunel:ready" },
    issue: {
      number: 6001,
      title: "Task detail repo test",
      body: "",
      labels: [{ name: "brunel:ready" }],
    },
    repository: { full_name: "owner/repo" },
  });

  // Navigate to the tasks list and find the task
  await page.goto("/tasks");
  // The task row should show the repo
  await expect(page.getByRole("link", { name: "#6001" })).toBeVisible();
  await expect(page.getByText("owner/repo").first()).toBeVisible();

  // Navigate to the task detail page
  await page.getByRole("link", { name: "#6001" }).click();
  // Task detail shows the repo
  await expect(page.getByText("owner/repo")).toBeVisible();
});

test("worker detail page: shows repo info", async ({ page }) => {
  const workerId = await connectWorker();

  try {
    await page.goto(`/workers/${workerId}`);
    // Worker detail should show the repo
    await expect(page.getByText("owner/repo")).toBeVisible();
  } finally {
    await disconnectWorker(workerId);
  }
});
