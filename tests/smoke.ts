/**
 * Smoke test: spawns a real foreman process and a real worker process and
 * asserts the full webhook → task → worker pipeline:
 *
 * 1. Worker connects to foreman ("Connected to foreman")
 * 2. POST a fake webhook payload to /webhook (issues/labeled event)
 * 3. Assert the worker receives task_assigned within the timeout
 * 4. Worker sends task_complete
 * 5. Assert the mock GitHub API received a label-apply call
 *
 * Run with: npm run smoke
 */
import { spawn, type ChildProcess, execSync } from "child_process";
import { existsSync, symlinkSync, unlinkSync, readFileSync, mkdtempSync, rmSync } from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocket } from "ws";
import crypto from "crypto";

const TIMEOUT_MS = 30_000;

// Resolve the root of the repository containing this smoke test.
// In a git worktree the .git entry is a file pointing at the common git dir;
// we use that to find the main worktree where node_modules lives.
const SMOKE_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = path.resolve(SMOKE_DIR, "..");

// Ensure node_modules is accessible for child processes. In a git worktree
// node_modules lives in the main checkout, not the worktree directory. Create a
// temporary symlink so Node's ESM module resolution can find packages.
let symlinkCreated = false;
const nmPath = path.join(REPO_ROOT, "node_modules");
if (!existsSync(nmPath)) {
  try {
    const gitRef = readFileSync(path.join(REPO_ROOT, ".git"), "utf8").trim();
    const match = gitRef.match(/^gitdir:\s*(.+?)\/worktrees\//);
    if (match) {
      const mainRoot = path.dirname(match[1]); // parent of the .git dir
      const mainNm = path.join(mainRoot, "node_modules");
      if (existsSync(mainNm)) {
        symlinkSync(mainNm, nmPath, "dir");
        symlinkCreated = true;
      }
    }
  } catch { /* not a worktree — proceed, will fail with a clear error if tsx can't find modules */ }
}

// Create a temporary bare git repo for the worker to clone
const tmpRepoDir = mkdtempSync(path.join(os.tmpdir(), "brunel-smoke-repo-"));
execSync(`git init --bare "${tmpRepoDir}"`);
const tmpWorkDir = mkdtempSync(path.join(os.tmpdir(), "brunel-smoke-work-"));
execSync(`git clone "${tmpRepoDir}" "${tmpWorkDir}"`, { stdio: "ignore" });
execSync(`git -C "${tmpWorkDir}" commit --allow-empty -m "init"`, {
  env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" },
});
execSync(`git -C "${tmpWorkDir}" push origin HEAD:main`);
const SMOKE_REPO_URL = `file://${tmpRepoDir}`;

function cleanup() {
  if (symlinkCreated && existsSync(nmPath)) unlinkSync(nmPath);
  rmSync(tmpRepoDir, { recursive: true, force: true });
  rmSync(tmpWorkDir, { recursive: true, force: true });
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/** Wait at most `timeoutMs` for `predicate` to return true, polling every 50ms. */
function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (predicate()) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`Timeout after ${timeoutMs}ms waiting for: ${label}`));
      }
    }, 50);
  });
}

async function run(): Promise<void> {
  const port = await freePort();
  const mockApiPort = await freePort();
  const foremanUrl = `ws://localhost:${port}`;
  const foremanHttpUrl = `http://localhost:${port}`;

  // Track label-apply calls received by the mock API.
  const labelCalls: Array<{ path: string; body: string }> = [];

  // Local mock GitHub API server — returns empty issues list so startup
  // succeeds without real GitHub credentials, handles GraphQL blocker
  // lookups with an empty response, and records label-apply calls.
  const mockApi = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      const urlPath = req.url ?? "/";

      // Record POST label calls: POST /repos/:owner/:repo/issues/:number/labels
      if (req.method === "POST" && /\/repos\/[^/]+\/[^/]+\/issues\/\d+\/labels$/.test(urlPath)) {
        labelCalls.push({ path: urlPath, body });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("[]");
        return;
      }

      // Handle GraphQL blocker queries — return empty blocker list.
      if (req.method === "POST" && urlPath === "/graphql") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          data: { repository: { issue: { blockedBy: { nodes: [] } } } },
        }));
        return;
      }

      // Default: return empty array (covers GET /repos/.../issues for startup).
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
    });
  });
  await new Promise<void>((resolve) => mockApi.listen(mockApiPort, resolve));

  const spawnOpts = { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] as const };

  const foreman = spawn("tsx", ["src/foreman.ts"], {
    ...spawnOpts,
    env: {
      ...process.env,
      PORT: String(port),
      GITHUB_REPO: "test/test",
      GITHUB_TOKEN: "dummy",
      BRUNEL_GITHUB_API_URL: `http://localhost:${mockApiPort}`,
    },
  });

  let worker: ChildProcess | null = null;
  let connected = false;

  // ── Phase 1: verify worker connects to foreman ─────────────────────────────

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout after ${TIMEOUT_MS}ms – connected=${connected}`));
    }, TIMEOUT_MS);

    function check() {
      if (connected) { clearTimeout(timer); resolve(); }
    }

    function spawnWorker() {
      worker = spawn("tsx", ["src/repl.ts", "--worker-mode"], {
        ...spawnOpts,
        env: { ...process.env, BRUNEL_FOREMAN_URL: foremanUrl, GITHUB_REPO: "test/test", GITHUB_TOKEN: "dummy", BRUNEL_REPO_URL: SMOKE_REPO_URL },
      });
      worker.stdout!.on("data", (buf: Buffer) => {
        process.stderr.write(`[worker stdout] ${buf}`);
        const text = buf.toString();
        if (text.includes("Connected to foreman")) { connected = true; check(); }
      });
      worker.stderr!.on("data", (buf: Buffer) => process.stderr.write(`[worker stderr] ${buf}`));
      worker.on("exit", (code) => {
        if (!connected)
          reject(new Error(`Worker exited prematurely with code ${code}`));
      });
    }

    foreman.stdout!.on("data", (buf: Buffer) => {
      process.stderr.write(`[foreman stdout] ${buf}`);
      if (!worker && buf.toString().includes("Listening on")) spawnWorker();
    });
    foreman.stderr!.on("data", (buf: Buffer) => process.stderr.write(`[foreman stderr] ${buf}`));
    foreman.on("exit", (code) => {
      if (!connected)
        reject(new Error(`Foreman exited prematurely with code ${code}`));
    });
  });

  console.log("✓ Phase 1: Worker connected to foreman");

  // Kill the real worker — it has no task, so the foreman will remove it from
  // the registry immediately on disconnect. The in-process fake worker below
  // will be the only idle worker when the webhook fires.
  //
  // Wait for the worker process to fully exit, then add a brief pause so the
  // foreman can process the TCP close event and remove the worker from its
  // registry before we post the webhook.
  //
  // SIGTERM alone doesn't always cause tsx to exit (pending async ops keep the
  // process alive). Send SIGTERM first; if the process hasn't exited within
  // 1 s, escalate to SIGKILL which is unconditional.
  // SIGTERM alone doesn't always cause tsx to exit (pending async ops keep the
  // process alive). Send SIGTERM first; if the process hasn't exited within
  // 1 s, escalate to SIGKILL which is unconditional. Once the process is gone
  // the OS closes the TCP socket and the foreman removes the worker from its
  // registry. The 200 ms pause lets that async processing complete.
  const workerExited = new Promise<void>((resolve) => worker!.once("exit", resolve));
  worker!.kill("SIGTERM");
  const killTimer = setTimeout(() => worker!.kill("SIGKILL"), 1000);
  await workerExited;
  clearTimeout(killTimer);
  await new Promise((r) => setTimeout(r, 200));

  // ── Phase 2–5: full webhook → task_assigned → task_complete → label pipeline

  const workerId = crypto.randomUUID();
  const TASK_LABEL = "brunel:ready";
  const ISSUE_NUMBER = 42;

  // Connect an in-process fake worker WebSocket.
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const sock = new WebSocket(`${foremanUrl}/worker`);
    sock.once("open", () => resolve(sock));
    sock.once("error", reject);
  });

  // FIFO message queue — safe against hello_ack + task_assigned in same TCP packet.
  const msgQueue: Array<Record<string, unknown>> = [];
  const msgWaiters: Array<(m: Record<string, unknown>) => void> = [];
  ws.on("message", (data: Buffer | string) => {
    const msg = JSON.parse(data.toString()) as Record<string, unknown>;
    process.stderr.write(`[fake-worker recv] ${JSON.stringify(msg)}\n`);
    const waiter = msgWaiters.shift();
    if (waiter) waiter(msg);
    else msgQueue.push(msg);
  });

  function nextWsMsg(): Promise<Record<string, unknown>> {
    if (msgQueue.length > 0) return Promise.resolve(msgQueue.shift()!);
    return new Promise((r) => msgWaiters.push(r));
  }

  function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after ${ms}ms waiting for: ${label}`)), ms),
      ),
    ]);
  }

  // Send worker_hello and wait for hello_ack (status: "idle").
  ws.send(JSON.stringify({ type: "worker_hello", workerId, status: "idle" }));
  const ack = await withTimeout(nextWsMsg(), TIMEOUT_MS, "hello_ack");
  if (ack.type !== "hello_ack" || ack.status !== "idle") {
    throw new Error(`Expected hello_ack idle, got: ${JSON.stringify(ack)}`);
  }
  process.stderr.write("[fake-worker] hello_ack received — worker is idle\n");

  // POST a fake issues/labeled webhook to the foreman.
  const webhookPayload = JSON.stringify({
    action: "labeled",
    label: { name: TASK_LABEL },
    issue: {
      number: ISSUE_NUMBER,
      title: "Smoke test issue",
      body: "",
      labels: [{ name: TASK_LABEL }],
    },
    repository: {
      html_url: "https://github.com/test/test",
      full_name: "test/test",
    },
  });

  await new Promise<void>((resolve, reject) => {
    const req = http.request(
      {
        hostname: "localhost",
        port,
        path: "/webhook",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-github-event": "issues",
          "x-github-delivery": "smoke-test-delivery-1",
          "Content-Length": Buffer.byteLength(webhookPayload),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Webhook POST returned HTTP ${res.statusCode}`));
        } else {
          resolve();
        }
        res.resume();
      },
    );
    req.on("error", reject);
    req.end(webhookPayload);
  });
  process.stderr.write("[smoke] webhook posted\n");

  // Wait for task_assigned.
  const taskAssigned = await withTimeout(nextWsMsg(), TIMEOUT_MS, "task_assigned");
  if (taskAssigned.type !== "task_assigned") {
    throw new Error(`Expected task_assigned, got: ${JSON.stringify(taskAssigned)}`);
  }
  const taskId = taskAssigned.taskId as string;
  process.stderr.write(`[fake-worker] task_assigned received — taskId=${taskId}\n`);
  console.log(`✓ Phase 2: Worker received task_assigned (issue #${ISSUE_NUMBER})`);

  // Send task_complete.
  ws.send(JSON.stringify({ type: "task_complete", workerId, taskId }));
  process.stderr.write("[fake-worker] task_complete sent\n");
  console.log("✓ Phase 3: Worker sent task_complete");

  // Wait for the mock API to receive the label-apply call.
  await withTimeout(
    waitFor(() => labelCalls.length > 0, TIMEOUT_MS, "label call"),
    TIMEOUT_MS,
    `label call to /repos/test/test/issues/${ISSUE_NUMBER}/labels`,
  );
  const labelCall = labelCalls[0];
  const expectedPath = `/repos/test/test/issues/${ISSUE_NUMBER}/labels`;
  if (!labelCall.path.includes(expectedPath)) {
    throw new Error(`Expected label call to ${expectedPath}, got: ${labelCall.path}`);
  }
  console.log(`✓ Phase 4: Mock API received label call (${labelCall.path})`);

  // Teardown
  ws.close();
  foreman.kill();
  mockApi.close();
}

run().catch((err) => {
  console.error("SMOKE TEST FAILED:", err.message);
  process.exit(1);
});
