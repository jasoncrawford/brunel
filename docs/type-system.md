# Type System Design

How model objects, wire types, and client types are organized in this codebase.

> **This is the target design.** The codebase is being incrementally refactored toward it. Existing code may not yet follow these conventions — when it doesn't, the direction of travel is here.

## Core pattern

Every domain concept has at most two types:

1. **A server model class** — rich, may persist to the DB, owns behavior
2. **A `Wire.*` interface** — the shape of data as it crosses any wire boundary (WebSocket, HTTP)

Shared domain types (enums, value objects used on both sides) live in `shared/types.ts`.

## The Wire namespace

All wire types live in `shared/wire.ts` and are imported with a namespace alias:

```ts
import * as Wire from "../../shared/wire.js";
```

This gives you `Wire.Task`, `Wire.WebhookEvent`, `Wire.ForemanMessage`, etc. — clearly distinct from the server model classes of the same name, with zero runtime cost (interfaces are erased by TypeScript).

Use TypeScript `interface` or `type` in `wire.ts`, never `class`. The `namespace` keyword is not used — the module alias achieves the same thing more idiomatically.

## Server model classes

Model classes are active records. They own DB reads/writes, hold in-memory state, and emit change events. All DB-backed model classes extend `ActiveRecord` (`src/foreman/models/active-record.ts`), which provides shared CRUD boilerplate (`get`, `getBy`, `list`, `insert`, `update`, `delete`, `select`). See the `Task` class for the canonical example of a subclass.

Each model class that needs to send data over a wire has a serialization method typed against the corresponding Wire interface:

```ts
class Task {
  toWire(): Wire.Task {
    return { taskId: this.taskId, title: this.title, status: this.status, ... };
  }
}
```

Typing the return value against `Wire.Task` means the compiler catches mismatches if either side changes.

**Unsaved records:** if a model instance may exist before being persisted, use `id: number | undefined`, not `id: 0` as a placeholder. An undefined `id` simply means the record is new and hasn't been saved yet — that's a valid state, not something to hide.

## Wire type design

**One type per concept.** Don't create multiple wire types for the same thing (`TaskSnapshot`, `TaskRow`, `TaskDetail`). Use a single `Wire.Task` with optional fields for data that isn't always present:

```ts
// wire.ts
export interface Task {
  taskId: string;
  issueNumber: number;
  title: string;
  status: TaskStatus;
  assignedWorkerId?: string;
  prNumber?: number;
  prUrl?: string;
  blockers?: BlockerInfo[];
  // Extended fields — present in REST responses, optional in WebSocket snapshots
  repo?: string;
  branch?: string;
  createdAt?: string;
  assignedAt?: string;
  completedAt?: string;
}
```

This avoids separate HTTP and WebSocket types for the same concept. Clients use what they need; absent fields are just absent.

**Naming:** use the unadorned concept name (`Wire.Task`, `Wire.WebhookEvent`). Add a suffix only when two genuinely distinct shapes of the same concept must coexist in the same scope — which should be rare.

**No input/create interfaces.** Don't write `TaskData` or `TaskInput` interfaces that mirror a model class's fields. Use named constructor params or the class directly.

## Protocol union types

The foreman↔worker WebSocket protocol is defined as union types in `wire.ts`:

```ts
export type ForemanMessage =
  | { type: "task_assigned"; taskId: string; task: Task }
  | { type: "event_notification"; taskId: string; event: WebhookEvent }
  | { type: "hello_ack"; workerId: string; status: "idle" | "busy" | "cancelled" };

export type WorkerMessage =
  | { type: "worker_hello"; workerId: string; claimedTaskId?: string }
  | { type: "task_complete"; taskId: string }
  | { type: "worker_goodbye"; taskId: string };
```

Payload types within the union reference the shared Wire interfaces directly rather than duplicating field definitions.

## Client-side types

**Use the Wire interface directly** when the client just renders or reads data — no class needed. The browser dashboard uses `Wire.Task` for both WebSocket snapshots and REST responses (same type, two delivery mechanisms).

**Create a client model class** when the client side needs behavior: methods, accumulated state, derived properties, or `instanceof` checks. This applies equally to the browser and the worker agent. A client model class typically takes a `Wire.*` object as its constructor input and adds the behavior on top. When a client model class exists, the Wire interface is its input contract, not a parallel type.

## Where things live

| What | Where |
|---|---|
| Server model classes | `src/foreman/models/*.ts` |
| Wire interfaces and protocol unions | `shared/wire.ts` |
| Shared domain types (enums, value objects) | `shared/types.ts` |
| Frontend-only UI state | `frontend/src/` (local, not in wire.ts) |
