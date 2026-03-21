/**
 * Smoke test: spawns a real foreman process and a real worker process and
 * asserts that the worker connects and receives standby.
 *
 * Run with: npm run smoke
 */
import { spawn, type ChildProcess } from "child_process";
import { existsSync, symlinkSync, unlinkSync, readFileSync } from "fs";
import * as net from "net";
import path from "path";
import { fileURLToPath } from "url";

const TIMEOUT_MS = 15_000;

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

function cleanup() {
  if (symlinkCreated && existsSync(nmPath)) unlinkSync(nmPath);
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

async function run(): Promise<void> {
  const port = await freePort();
  const foremanUrl = `ws://localhost:${port}`;

  const spawnOpts = { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] as const };

  const foreman = spawn("tsx", ["src/foreman.ts"], {
    ...spawnOpts,
    env: { ...process.env, PORT: String(port), GITHUB_REPO: "test/test", GITHUB_TOKEN: "dummy" },
  });

  let worker: ChildProcess | null = null;
  let connected = false;
  let standby = false;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout after ${TIMEOUT_MS}ms – connected=${connected}, standby=${standby}`));
    }, TIMEOUT_MS);

    function check() {
      if (connected && standby) { clearTimeout(timer); resolve(); }
    }

    function spawnWorker() {
      worker = spawn("tsx", ["src/repl.ts", "--worker-mode"], {
        ...spawnOpts,
        env: { ...process.env, FOREMAN_URL: foremanUrl, GITHUB_REPO: "test/test", GITHUB_TOKEN: "dummy" },
      });
      worker.stdout!.on("data", (buf: Buffer) => {
        const text = buf.toString();
        if (text.includes("Connected to foreman")) { connected = true; check(); }
        if (text.includes("Standby")) { standby = true; check(); }
      });
      worker.stderr!.on("data", (buf: Buffer) => process.stderr.write(buf));
      worker.on("exit", (code) => {
        if (!connected || !standby)
          reject(new Error(`Worker exited prematurely with code ${code}`));
      });
    }

    foreman.stdout!.on("data", (buf: Buffer) => {
      if (!worker && buf.toString().includes("Listening on")) spawnWorker();
    });
    foreman.stderr!.on("data", (buf: Buffer) => process.stderr.write(buf));
    foreman.on("exit", (code) => {
      if (!connected || !standby)
        reject(new Error(`Foreman exited prematurely with code ${code}`));
    });
  });

  console.log("✓ Worker connected to foreman and received standby");
  foreman.kill();
  worker!.kill();
}

run().catch((err) => {
  console.error("SMOKE TEST FAILED:", err.message);
  process.exit(1);
});
