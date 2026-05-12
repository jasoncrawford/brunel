/**
 * Regression test for issue #1093: worker process hangs instead of exiting.
 *
 * Root cause: after the routing loop exits, process.exit() was never called.
 * The WebSocket ping timer (setInterval) kept the event loop alive while waiting
 * for the graceful CLOSE handshake to complete (up to 30 seconds).
 *
 * This test verifies the worker exits within 5 seconds after /exit, even when
 * the foreman WebSocket does not respond to the CLOSE frame — which is what
 * caused the indefinite hang in the original bug.
 *
 * Run with: npm run test:worker-exit (or directly: tsx tests/worker-exit.ts)
 */
import { spawn, execSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import * as crypto from "crypto";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import path from "path";
import { fileURLToPath } from "url";

const EXIT_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 15_000;
const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

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

function makeTempRepo(): { repoUrl: string; cleanup: () => void } {
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const bareDir = mkdtempSync(path.join(os.tmpdir(), "brunel-exit-test-"));
  const workDir = mkdtempSync(path.join(os.tmpdir(), "brunel-exit-work-"));
  // Use -b main so the default branch is main, avoiding @{u}..HEAD issues on clone.
  execSync(`git init --bare -b main "${bareDir}"`);
  execSync(`git clone "${bareDir}" "${workDir}"`, { stdio: "ignore" });
  execSync(`git -C "${workDir}" commit --allow-empty -m "init"`, { env: gitEnv });
  execSync(`git -C "${workDir}" push origin HEAD:main`);
  return {
    repoUrl: `file://${bareDir}`,
    cleanup: () => {
      rmSync(bareDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}

// ── Minimal raw WebSocket server ────────────────────────────────────────────
//
// We need a WebSocket server that:
//   1. Completes the HTTP upgrade handshake
//   2. Accepts worker_hello and sends hello_ack
//   3. Does NOT respond to WebSocket CLOSE frames
//
// Without responding to CLOSE, the worker's WebSocket hangs for up to 30 seconds
// waiting for the CLOSE acknowledgement. This is the condition that caused #1093.
// Using the `ws` library is not suitable here because it auto-responds to CLOSE
// frames per the WebSocket spec, which would mask the bug.

function wsAccept(key: string): string {
  return crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
}

function decodeFrame(buf: Buffer): { opcode: number; payload: Buffer } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  if (masked) {
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) payload[i] = buf[offset + i] ^ mask[i % 4];
    return { opcode, payload };
  }
  return { opcode, payload: buf.subarray(offset, offset + payloadLen) };
}

function encodeFrame(opcode: number, data: Buffer | string): Buffer {
  const payload = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const len = payload.length;
  const header = len < 126
    ? Buffer.from([0x80 | opcode, len])
    : Buffer.from([0x80 | opcode, 126, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.concat([header, payload]);
}

function startRawWsServer(port: number): { server: http.Server; onHello: Promise<void> } {
  let helloResolve: () => void;
  const onHello = new Promise<void>((r) => { helloResolve = r; });

  const server = http.createServer();
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"] as string;
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n` +
      "\r\n",
    );

    let buf = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const frame = decodeFrame(buf);
      if (!frame) return;
      buf = Buffer.alloc(0); // consumed

      if (frame.opcode === 1 /* TEXT */) {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(frame.payload.toString()); } catch { return; }
        if (msg.type === "worker_hello") {
          const ack = JSON.stringify({ type: "hello_ack", status: "ready", repoStatus: "active" });
          socket.write(encodeFrame(1, ack));
          helloResolve!();
        }
        // Ignore all other messages including goodbye, etc.
      }
      // Opcode 8 = CLOSE — deliberately ignored so the handshake is never completed.
      // This simulates a slow foreman and is the exact condition that caused #1093.
    });
  });

  server.listen(port);
  return { server, onHello };
}

// ── Main test ────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const port = await freePort();
  const { repoUrl, cleanup } = makeTempRepo();
  process.on("exit", cleanup);

  const { server, onHello } = startRawWsServer(port);
  await new Promise<void>((resolve) => server.once("listening", resolve));

  const worker = spawn("tsx", ["src/agent/index.ts", "worker:start"], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      BRUNEL_FOREMAN_URL: `ws://localhost:${port}`,
      BRUNEL_REPO_URL: repoUrl,
      GITHUB_REPO: "test/test",
      GITHUB_TOKEN: "dummy",
    },
  });

  worker.stderr!.on("data", (buf: Buffer) => process.stderr.write(`[worker stderr] ${buf}`));

  // Wait for worker_hello to arrive (confirms the WS connection is live).
  await Promise.race([
    onHello,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timeout after ${CONNECT_TIMEOUT_MS}ms waiting for worker_hello`)),
        CONNECT_TIMEOUT_MS,
      ),
    ),
    new Promise<never>((_, reject) =>
      worker.once("exit", (code) =>
        reject(new Error(`Worker exited prematurely with code ${code}`)),
      ),
    ),
  ]);

  process.stderr.write("[test] worker_hello received — sending /exit\n");

  // Send /exit command. Worker is in "waiting" state (active, no task).
  worker.stdin!.write("/exit\n");

  // Assert the worker exits within EXIT_TIMEOUT_MS.
  // Without process.exit(0) in start(), the WebSocket ping timer (setInterval)
  // keeps the event loop alive until the CLOSE timeout (~30s).
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.kill("SIGKILL");
      reject(
        new Error(
          `Worker did not exit within ${EXIT_TIMEOUT_MS}ms after /exit — ` +
          "likely hung on WebSocket CLOSE handshake (issue #1093)",
        ),
      );
    }, EXIT_TIMEOUT_MS);
    worker.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) { resolve(); }
      else { reject(new Error(`Worker exited with code ${code}`)); }
    });
  });

  server.close();
  console.log("✓ Worker exited cleanly after /exit");
}

run().catch((err) => {
  console.error("WORKER EXIT TEST FAILED:", err.message);
  process.exit(1);
});
