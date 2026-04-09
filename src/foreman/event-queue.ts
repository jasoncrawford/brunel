import type { GitHubEvent } from "../types.js";

// ── EventQueue ─────────────────────────────────────────────────────────────────
// Buffers GitHub events for workers that aren't connected yet.
// Keyed by taskId; events are drained and forwarded when a worker connects.

export class EventQueue {
  private queues = new Map<string, GitHubEvent[]>();

  enqueue(taskId: string, event: GitHubEvent): void {
    let q = this.queues.get(taskId);
    if (!q) { q = []; this.queues.set(taskId, q); }
    q.push(event);
  }

  drain(taskId: string): GitHubEvent[] {
    const q = this.queues.get(taskId);
    if (!q || q.length === 0) return [];
    this.queues.delete(taskId);
    return q;
  }
}
