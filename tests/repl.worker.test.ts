import { describe, it, expect, vi } from "vitest";
import * as http from "http";
import { createForemanWss, WorkerRegistry, TaskQueue } from "../src/foreman.js";
import { connectToForeman, handleForemanMessage } from "../src/repl.js";
import * as display from "../src/display.js";
import type { ForemanMessage, TaskIssue, GitHubEvent } from "../src/types.js";

function startTestForeman(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer();
    const { wss } = createForemanWss(new TaskQueue(), new WorkerRegistry(), server);
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      resolve({ port, close: () => { wss.close(); server.close(); } });
    });
  });
}

describe("handleForemanMessage", () => {
  it("calls display.printForemanMessage with the message (regression: ReferenceError on connect)", () => {
    // Before the fix, printForemanMessage was called as a bare name and threw:
    //   ReferenceError: printForemanMessage is not defined
    const spy = vi.spyOn(display, "printForemanMessage").mockImplementation(() => {});
    const msg: ForemanMessage = { type: "standby" };

    handleForemanMessage(msg, { onTaskAssigned: vi.fn(), onEventNotification: vi.fn() });

    expect(spy).toHaveBeenCalledWith(msg);
    spy.mockRestore();
  });

  it("invokes onTaskAssigned callback for task_assigned messages", () => {
    vi.spyOn(display, "printForemanMessage").mockImplementation(() => {});
    const issue: TaskIssue = { number: 1, title: "T", body: "", labels: [], repoUrl: "r" };
    const msg: ForemanMessage = { type: "task_assigned", taskId: "42", issue };
    const onTaskAssigned = vi.fn();

    handleForemanMessage(msg, { onTaskAssigned, onEventNotification: vi.fn() });

    expect(onTaskAssigned).toHaveBeenCalledWith("42", issue);
    vi.restoreAllMocks();
  });

  it("invokes onEventNotification callback for event_notification messages", () => {
    vi.spyOn(display, "printForemanMessage").mockImplementation(() => {});
    const event: GitHubEvent = { id: "1", name: "push", payload: {} };
    const msg: ForemanMessage = { type: "event_notification", taskId: "42", event };
    const onEventNotification = vi.fn();

    handleForemanMessage(msg, { onTaskAssigned: vi.fn(), onEventNotification });

    expect(onEventNotification).toHaveBeenCalledWith(event);
    vi.restoreAllMocks();
  });
});

describe("worker WebSocket connection", () => {
  it("worker client connects to foreman and completes handshake", async () => {
    const { port, close } = await startTestForeman();

    // connectToForeman is the real client code: constructs the /worker URL and sends worker_hello
    const ws = connectToForeman(`ws://localhost:${port}`, "test-worker-id");

    const msg = await new Promise<ForemanMessage>((resolve, reject) => {
      ws.on("message", (data) => resolve(JSON.parse(data.toString())));
      ws.on("error", reject);
    });

    expect(msg.type).toBe("standby");

    ws.close();
    close();
  });

  it("foreman rejects connections not at /worker path (regression guard)", async () => {
    const { port, close } = await startTestForeman();

    // Original bug: bare URL gets socket.destroy()'d by the real foreman routing
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://localhost:${port}`);
    await expect(
      new Promise<void>((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      })
    ).rejects.toThrow();

    close();
  });
});
