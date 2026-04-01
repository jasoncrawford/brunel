/**
 * One-off backfill script: sync all tasks rows against current GitHub issue state.
 *
 * For each task in the DB:
 *   - Fetches the current issue from GitHub to get title, body, labels, and state.
 *   - Updates title/body/labels in the DB for all tasks.
 *   - If the issue is closed and the task is not already complete, marks it complete.
 *     (Assigned tasks whose issues are closed will never be reclaimed — safe to close.)
 *
 * Usage:
 *   npx tsx scripts/backfill-tasks.ts [--dry-run]
 *
 * Reads config from the usual sources (brunel.config.ts / .env / BRUNEL_* env vars).
 * Requires SUPABASE_URL and SUPABASE_SECRET_KEY (or equivalents) to be set.
 */

import { createClient } from "@supabase/supabase-js";
import { loadConfig } from "../src/config.js";
import { createTaskStore } from "../src/db.js";

const dryRun = process.argv.includes("--dry-run");

const config = await loadConfig(process.argv.slice(2).filter(a => a !== "--dry-run"));
const { githubRepo: repo, githubToken: token, supabaseUrl, supabaseSecretKey } = config;

if (!supabaseUrl || !supabaseSecretKey) {
  console.error("ERROR: supabaseUrl and supabaseSecretKey are required.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseSecretKey);
const taskStore = createTaskStore(supabase);

const [owner, repoName] = repo.split("/");

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: Array<{ name: string }>;
}

async function fetchIssue(issueNumber: number): Promise<GitHubIssue> {
  const url = `https://api.github.com/repos/${owner}/${repoName}/issues/${issueNumber}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for issue #${issueNumber}`);
  return res.json() as Promise<GitHubIssue>;
}

async function main() {
  console.log(`Fetching all tasks from DB${dryRun ? " [DRY RUN]" : ""}...`);
  const tasks = await taskStore.listTasks({ limit: 1000 });
  console.log(`Found ${tasks.length} tasks.`);

  let updated = 0;
  let closed = 0;
  let errors = 0;

  for (const task of tasks) {
    process.stdout.write(`  #${task.issueNumber} (${task.taskId}) [${task.status}] ... `);
    try {
      const issue = await fetchIssue(task.issueNumber);
      const title = issue.title;
      const body = issue.body ?? "";
      const labels = issue.labels.map(l => l.name);
      const issueClosed = issue.state === "closed";

      const actions: string[] = [];

      if (title !== task.title || body !== task.body || labels.join(",") !== task.labels.join(",")) {
        actions.push("update title/body/labels");
        if (!dryRun) {
          await supabase.from("tasks")
            .update({ title, body, labels })
            .eq("task_id", task.taskId);
        }
        updated++;
      }

      if (issueClosed && task.status !== "complete") {
        actions.push(`mark complete (issue closed, was ${task.status})`);
        if (!dryRun) {
          await taskStore.markComplete(task.taskId);
        }
        closed++;
      }

      console.log(actions.length > 0 ? actions.join(", ") : "no change");
    } catch (err) {
      console.log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      errors++;
    }
  }

  console.log(`\nDone. ${updated} content updates, ${closed} marked complete, ${errors} errors.`);
  if (dryRun) console.log("(Dry run — no changes written.)");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
