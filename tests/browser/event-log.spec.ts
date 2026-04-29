/**
 * Browser tests for the event log page (/log).
 *
 * Uses Playwright's route interception to mock /api/log responses so
 * pagination can be tested without a real database.
 */
import { test, expect } from "@playwright/test";

function makeEntries(startId: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    kind: "webhook",
    id: startId + i,
    timestamp: new Date(Date.now() - (startId + i) * 1000).toISOString(),
    taskId: null,
    workerId: null,
    repo: "owner/repo",
    summary: `entry-${startId + i}`,
  }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("event log: shows initial entries on load", async ({ page }) => {
  await page.route("**/api/log**", async (route) => {
    await route.fulfill({ json: makeEntries(0, 10) });
  });

  await page.goto("/log");

  await expect(page.getByRole("heading", { name: "Event Log" })).toBeVisible();
  await expect(page.getByText("entry-0")).toBeVisible();
  await expect(page.getByText("entry-9")).toBeVisible();
});

test("event log: load-more button appears when page is full and disappears after last page", async ({ page }) => {
  const PAGE_SIZE = 50;

  await page.route("**/api/log**", async (route) => {
    const url = new URL(route.request().url());
    const hasBefore = url.searchParams.has("before");
    await route.fulfill({
      json: hasBefore ? makeEntries(PAGE_SIZE, 5) : makeEntries(0, PAGE_SIZE),
    });
  });

  await page.goto("/log");

  // First entry visible
  await expect(page.getByText("entry-0")).toBeVisible();

  // Load-more button present (50 = PAGE_SIZE → more pages may exist)
  const loadMoreBtn = page.getByRole("button", { name: "Load more" });
  await expect(loadMoreBtn).toBeVisible();

  // Click load-more
  await loadMoreBtn.click();

  // Second page entries appended
  await expect(page.getByText(`entry-${PAGE_SIZE}`)).toBeVisible();

  // Load-more gone (5 < PAGE_SIZE → no more pages)
  await expect(loadMoreBtn).not.toBeVisible();
});

test("event log: passes before cursor from last entry of current page", async ({ page }) => {
  const PAGE_SIZE = 50;
  const firstPageEntries = makeEntries(0, PAGE_SIZE);
  const expectedCursor = firstPageEntries[firstPageEntries.length - 1].timestamp;

  let capturedBefore: string | null = null;
  await page.route("**/api/log**", async (route) => {
    const url = new URL(route.request().url());
    capturedBefore = url.searchParams.get("before");
    await route.fulfill({ json: capturedBefore ? makeEntries(PAGE_SIZE, 3) : firstPageEntries });
  });

  await page.goto("/log");
  await expect(page.getByText("entry-0")).toBeVisible();

  await page.getByRole("button", { name: "Load more" }).click();

  await expect(page.getByText(`entry-${PAGE_SIZE}`)).toBeVisible();
  expect(capturedBefore).toBe(expectedCursor);
});
