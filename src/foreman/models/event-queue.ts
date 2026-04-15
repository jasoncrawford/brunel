import type { WebhookEvent } from "./webhook-event.js";
import type { Task } from "./task.js";

// ── EventQueue ─────────────────────────────────────────────────────────────────
// Buffers GitHub events for workers that aren't connected yet.
// Keyed by taskId; events are drained and forwarded when a worker connects.

export class EventQueue {
  private queues = new Map<string, WebhookEvent[]>();

  enqueue(task: Task, event: WebhookEvent): void {
    const taskId = task.taskId;
    let q = this.queues.get(taskId);
    if (!q) { q = []; this.queues.set(taskId, q); }
    q.push(event);
  }

  drain(task: Task): WebhookEvent[] {
    const taskId = task.taskId;
    const q = this.queues.get(taskId);
    if (!q || q.length === 0) return [];
    this.queues.delete(taskId);
    return q;
  }
}
