import type { WebhookEvent } from "./models/webhook-event.js";

// ── EventQueue ─────────────────────────────────────────────────────────────────
// Buffers GitHub events for workers that aren't connected yet.
// Keyed by taskId; events are drained and forwarded when a worker connects.

export class EventQueue {
  private queues = new Map<string, WebhookEvent[]>();

  enqueue(taskId: string, event: WebhookEvent): void {
    let q = this.queues.get(taskId);
    if (!q) { q = []; this.queues.set(taskId, q); }
    q.push(event);
  }

  drain(taskId: string): WebhookEvent[] {
    const q = this.queues.get(taskId);
    if (!q || q.length === 0) return [];
    this.queues.delete(taskId);
    return q;
  }
}
