/**
 * Browser tests for the worker detail page (/workers/:id).
 *
 * Verifies that navigating to a worker's page shows the correct heading
 * and that live WebSocket messages (broadcast by the foreman when worker
 * messages are exchanged) appear in the message history table.
 */
import { test, expect } from "@playwright/test";

const BASE = "http://localhost:14567";

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

test("worker detail page: shows correct worker ID in heading", async ({
  page,
}) => {
  const workerId = await connectWorker();

  try {
    await page.goto(`/workers/${workerId}`);

    // The page heading shows the first 8 characters of the worker ID
    await expect(
      page.getByRole("heading", { name: new RegExp(workerId.slice(0, 8)) }),
    ).toBeVisible();
  } finally {
    await disconnectWorker(workerId);
  }
});

test("worker detail page: live messages appear when the worker disconnects", async ({
  page,
}) => {
  // Connect a worker so we know its ID and can navigate to its detail page
  const workerId = await connectWorker();

  // Set up the admin WebSocket listener BEFORE navigating so we don't miss the
  // connection event.  React's useEffect runs after the page's load event, so
  // without this wait we could disconnect the worker before the page's admin WS
  // has subscribed — causing the log_event to be missed.
  const adminWsReady = page.waitForEvent("websocket", (ws) =>
    ws.url().includes("/admin/ws"),
  );

  // Navigate to the worker's detail page while the worker is still connected
  await page.goto(`/workers/${workerId}`);

  // Wait for the admin WebSocket to open and receive the initial snapshot/log,
  // confirming the page is ready to receive live log_events
  const adminWs = await adminWsReady;
  await adminWs.waitForEvent("framereceived", { timeout: 5000 });

  // Disconnect the worker — the foreman broadcasts a "worker_disconnected"
  // log_event with workerId set.  WorkerDetail listens for log_events with
  // the matching workerId and appends them to the messages table in real time.
  await disconnectWorker(workerId);

  // The disconnect entry should appear live without a page reload
  await expect(page.getByText(/disconnected/)).toBeVisible();
});
