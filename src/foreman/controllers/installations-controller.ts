import { Installation } from "../models/installation.js";
import { Repo } from "../models/repo.js";
import { log, fmtError } from "../../utils.js";

type R = Record<string, unknown>;

export class InstallationsController {

  async handleInstallationCreated(payload: unknown): Promise<void> {
    const p = payload as R;
    const inst = p.installation as R;
    const githubId = inst.id as number;
    const account = inst.account as R;
    const accountLogin = account.login as string;
    const accountType = account.type as string;
    const targetType = inst.target_type as string;

    const installation = await Installation.insert({ github_id: githubId, account_login: accountLogin, account_type: accountType });

    if (targetType === "User") {
      const repos = (p.repositories as Array<{ full_name: string }>) ?? [];
      await Promise.all(repos.map((r) => this._activateRepo(r.full_name, installation.id, githubId)));
    }
  }

  async handleInstallationDeleted(payload: unknown): Promise<void> {
    const p = payload as R;
    const inst = p.installation as R;
    const githubId = inst.id as number;

    const installation = await Installation.getByGithubId(githubId);
    if (!installation) return;

    const repos = await Repo.listByInstallation(installation.id);
    await Promise.all(repos.map((repo) => this._deactivateRepo(repo)));
    await installation.delete();
  }

  async handleReposAdded(payload: unknown): Promise<void> {
    const p = payload as R;
    const inst = p.installation as R;
    const githubId = inst.id as number;
    const targetType = inst.target_type as string;

    if (targetType !== "User") return;

    const installation = await Installation.getByGithubId(githubId);
    if (!installation) {
      log(`[installations] installation ${githubId} not found for repos_added — skipping`);
      return;
    }

    const repos = (p.repositories_added as Array<{ full_name: string }>) ?? [];
    await Promise.all(repos.map((r) => this._activateRepo(r.full_name, installation.id, githubId)));
  }

  async handleReposRemoved(payload: unknown): Promise<void> {
    const p = payload as R;
    const repos = (p.repositories_removed as Array<{ full_name: string }>) ?? [];
    await Promise.all(repos.map(async (r) => {
      const repo = await Repo.findByFullName(r.full_name);
      if (repo) await this._deactivateRepo(repo);
    }));
  }

  private async _activateRepo(fullName: string, installationId: number, installationGithubId: number): Promise<void> {
    const repo = await Repo.findOrCreate(fullName);
    await repo.linkInstallation(installationId);
    await repo.activate();
    try {
      await repo.taskManager.loadIssuesFromGithub(installationGithubId);
    } catch (err) {
      log(`[installations] ERROR loading issues for ${fullName}: ${fmtError(err)}`);
    }
  }

  private async _deactivateRepo(repo: Repo): Promise<void> {
    await repo.unlink();
    await repo.deactivate();
  }
}
