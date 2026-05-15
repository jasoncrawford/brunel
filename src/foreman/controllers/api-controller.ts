import type { Hono } from "hono";
import { Task } from "../models/task.js";
import { Repo } from "../models/repo.js";
import { Worker } from "../models/worker.js";
import { queryActivityLog } from "../models/activity-log.js";
import type { TaskStatus } from "../../../shared/wire.js";
import { fmtError, log } from "../../utils.js";
import { getConfig } from "../../config.js";

export class ApiController {
  register(app: Hono): void {
    app.get("/api/config", (c) => {
      return c.json({ taskLabel: getConfig().taskLabel });
    });

    app.get("/api/log", async (c) => {
      try {
        const before = c.req.query("before");
        const entries = await queryActivityLog({ limit: 50, ...(before ? { before } : {}) });
        return c.json(entries);
      } catch (err) {
        log(`ERROR API query failed: ${fmtError(err)}`);
        return c.json({ error: "internal error" }, 500);
      }
    });

    app.get("/api/tasks/:id", async (c) => {
      try {
        const task = await Task.get(c.req.param("id"));
        if (!task) return c.json({ error: "not found" }, 404);
        return c.json(task.toWire());
      } catch (err) {
        log(`ERROR API query failed: ${fmtError(err)}`);
        return c.json({ error: "internal error" }, 500);
      }
    });

    app.get("/api/tasks/:id/events", async (c) => {
      try {
        const taskId = c.req.param("id");
        const before = c.req.query("before");
        const entries = await queryActivityLog({ taskId, limit: 50, ...(before ? { before } : {}) });
        return c.json(entries);
      } catch (err) {
        log(`ERROR API query failed: ${fmtError(err)}`);
        return c.json({ error: "internal error" }, 500);
      }
    });

    app.get("/api/workers/:id", async (c) => {
      try {
        const workerId = c.req.param("id");
        const worker = await Worker.get(workerId);
        if (!worker) return c.json({ error: "not found" }, 404);
        return c.json(worker.toWire());
      } catch (err) {
        log(`ERROR API query failed: ${fmtError(err)}`);
        return c.json({ error: "internal error" }, 500);
      }
    });

    app.get("/api/workers/:id/messages", async (c) => {
      try {
        const workerId = c.req.param("id");
        const before = c.req.query("before");
        const entries = await queryActivityLog({ workerId, limit: 50, ...(before ? { before } : {}) });
        return c.json(entries);
      } catch (err) {
        log(`ERROR API query failed: ${fmtError(err)}`);
        return c.json({ error: "internal error" }, 500);
      }
    });

    app.get("/api/tasks", async (c) => {
      try {
        const statusFilter = c.req.query("status") as TaskStatus | undefined;
        const tasks = await Task.list();
        const filtered = statusFilter
          ? tasks.filter((t) => t.status === statusFilter)
          : tasks.filter((t) => t.status !== "complete");
        return c.json(filtered.map((t) => t.toWire()));
      } catch (err) {
        log(`ERROR API query failed: ${fmtError(err)}`);
        return c.json({ error: "internal error" }, 500);
      }
    });

    app.get("/api/repos", async (c) => {
      try {
        const repos = await Repo.list();
        return c.json(repos.map((r) => r.toWire()));
      } catch (err) {
        log(`ERROR API query failed: ${fmtError(err)}`);
        return c.json({ error: "internal error" }, 500);
      }
    });

    app.get("/api/repos/:owner/:repo", async (c) => {
      try {
        const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
        const repo = await Repo.findByFullName(fullName);
        if (!repo) return c.json({ error: "not found" }, 404);
        const installation = await repo.installation;
        return c.json({ ...repo.toWire(), installation: installation?.toWire() ?? null });
      } catch (err) {
        log(`ERROR API query failed: ${fmtError(err)}`);
        return c.json({ error: "internal error" }, 500);
      }
    });

    app.get("/api/repos/:id/log", async (c) => {
      try {
        const repoId = Number(c.req.param("id"));
        const before = c.req.query("before");
        const entries = await queryActivityLog({ repoId, limit: 50, ...(before ? { before } : {}) });
        return c.json(entries);
      } catch (err) {
        log(`ERROR API query failed: ${fmtError(err)}`);
        return c.json({ error: "internal error" }, 500);
      }
    });
  }
}
