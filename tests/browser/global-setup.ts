/**
 * Global setup: builds the frontend SPA if dist/index.html doesn't exist yet.
 * The foreman serves dist/ as static files, so the build must exist before tests run.
 */
import { execSync } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

export default async function globalSetup() {
  const root = path.resolve(fileURLToPath(import.meta.url), "../../..");
  const distIndex = path.join(root, "dist", "index.html");

  if (!existsSync(distIndex)) {
    console.log("[browser-tests] Building frontend...");
    execSync("npm run build", { cwd: root, stdio: "inherit" });
    console.log("[browser-tests] Frontend built.");
  } else {
    console.log("[browser-tests] Using existing dist/ build.");
  }
}
