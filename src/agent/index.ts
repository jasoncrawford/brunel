import "dotenv/config";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "url";
import { Display } from "./views/display.js";
import { StatusBar } from "./views/status-bar.js";
import { loadConfig } from "../config.js";
import { Settings } from "./models/settings.js";
import { generateAgentId } from "./controllers/worker-controller.js";
import { AgentController } from "./controllers/agent-controller.js";

// ── Startup ───────────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = await loadConfig(process.argv);
  const settings = new Settings({ model: config.model, effort: config.effort });
  const statusBar = new StatusBar({ agentId: generateAgentId(), settings });
  const display = new Display(config, statusBar);
  const permConfig = {
    permissionMode: config.permissionMode,
    allowDangerouslySkipPermissions: config.allowDangerouslySkipPermissions,
  };

  const workspaceCfg = (config.githubRepo && config.githubToken)
    ? {
        workspaceDir: config.workspaceDir ?? path.join(os.homedir(), ".brunel", "workers"),
        repoUrl: `https://${config.githubToken}@github.com/${config.githubRepo}.git`,
      }
    : undefined;

  const runWorkerMode = process.argv.includes("--worker-mode");

  const agentController = new AgentController(display, permConfig, settings);
  await agentController.start(runWorkerMode, workspaceCfg);
}
