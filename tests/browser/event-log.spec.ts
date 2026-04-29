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

test("event log: appends next page and removes load-more after last page", async ({ page }) => {
  const PAGE_SIZE = 50;

  await page.route("**/api/log**", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      json: url.searchParams.has("before") ? makeEntries(PAGE_SIZE, 5) : makeEntries(0, PAGE_SIZE),
    });
  });

  await page.goto("/log");
  await expect(page.getByText("entry-0")).toBeVisible();

  // Scroll to bottom — triggers IntersectionObserver if it hasn't already fired
  // (on short CI viewports it may auto-fire; on taller ones the scroll triggers it)
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

  // Next-page entries appear (5 entries appended)
  await expect(page.getByText(`entry-${PAGE_SIZE}`)).toBeVisible();

  // 5 < PAGE_SIZE → no more pages → load-more sentinel gone
  await expect(page.getByRole("button", { name: "Load more" })).not.toBeVisible();
});

test("event log: passes before cursor from last entry of current page", async ({ page }) => {
  const PAGE_SIZE = 50;
  const firstPage = makeEntries(0, PAGE_SIZE);
  const expectedCursor = firstPage[firstPage.length - 1].timestamp;

  let capturedBefore: string | null = null;
  await page.route("**/api/log**", async (route) => {
    const url = new URL(route.request().url());
    const before = url.searchParams.get("before");
    if (before) capturedBefore = before;
    await route.fulfill({ json: before ? makeEntries(PAGE_SIZE, 3) : firstPage });
  });

  await page.goto("/log");
  await expect(page.getByText("entry-0")).toBeVisible();

  // Scroll to bottom to ensure load-more fires (auto or manual)
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

  await expect(page.getByText(`entry-${PAGE_SIZE}`)).toBeVisible();

  // The before cursor must equal the timestamp of the last entry on page 1
  expect(capturedBefore).toBe(expectedCursor);
});
