/**
 * Tests for InstallationsController — handles GitHub App installation lifecycle:
 * installation.created/deleted and installation_repositories.added/removed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InstallationsController } from "../src/foreman/controllers/installations-controller.js";
import { Installation } from "../src/foreman/models/installation.js";
import { Repo } from "../src/foreman/models/repo.js";
import { resetDb } from "./helpers/task.js";

// ── Payload factories ──────────────────────────────────────────────────────────

function installationCreatedPayload(
  githubId: number,
  accountLogin: string,
  targetType: "User" | "Organization",
  repoFullNames: string[],
) {
  return {
    action: "created",
    installation: {
      id: githubId,
      account: { login: accountLogin, type: targetType },
      target_type: targetType,
    },
    repositories: repoFullNames.map((full_name) => ({
      full_name,
      name: full_name.split("/")[1],
    })),
  };
}

function installationDeletedPayload(githubId: number, accountLogin: string) {
  return {
    action: "deleted",
    installation: {
      id: githubId,
      account: { login: accountLogin, type: "User" },
      target_type: "User",
    },
    repositories: [],
  };
}

function installationRepositoriesAddedPayload(
  githubId: number,
  accountLogin: string,
  targetType: "User" | "Organization",
  repoFullNames: string[],
) {
  return {
    action: "added",
    installation: {
      id: githubId,
      account: { login: accountLogin, type: targetType },
      target_type: targetType,
    },
    repositories_added: repoFullNames.map((full_name) => ({
      full_name,
      name: full_name.split("/")[1],
    })),
    repositories_removed: [],
  };
}

function installationRepositoriesRemovedPayload(
  githubId: number,
  accountLogin: string,
  repoFullNames: string[],
) {
  return {
    action: "removed",
    installation: {
      id: githubId,
      account: { login: accountLogin, type: "User" },
      target_type: "User",
    },
    repositories_added: [],
    repositories_removed: repoFullNames.map((full_name) => ({
      full_name,
      name: full_name.split("/")[1],
    })),
  };
}

// ── Test setup ────────────────────────────────────────────────────────────────

let controller: InstallationsController;

beforeEach(() => {
  resetDb();
  // Mock fetch so loadIssuesFromGithub doesn't make real HTTP calls.
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => [],
  }));
  controller = new InstallationsController();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── installation.created — User (direct-repo) install ────────────────────────

describe("handleInstallationCreated — User target", () => {
  it("creates an Installation record", async () => {
    await controller.handleInstallationCreated(
      installationCreatedPayload(11111, "alice", "User", ["alice/my-repo"]),
    );
    const inst = await Installation.getByGithubId(11111);
    expect(inst).not.toBeNull();
    expect(inst!.accountLogin).toBe("alice");
    expect(inst!.accountType).toBe("User");
  });

  it("activates and links repos in the repositories array", async () => {
    await controller.handleInstallationCreated(
      installationCreatedPayload(11111, "alice", "User", ["alice/my-repo"]),
    );
    const repo = await Repo.findOrCreate("alice/my-repo");
    expect(repo.status).toBe("active");
    expect(repo.installationId).not.toBeNull();
  });

  it("links the repo to the correct Installation by DB id", async () => {
    await controller.handleInstallationCreated(
      installationCreatedPayload(11111, "alice", "User", ["alice/my-repo"]),
    );
    const inst = await Installation.getByGithubId(11111);
    const repo = await Repo.findOrCreate("alice/my-repo");
    expect(repo.installationId).toBe(inst!.id);
  });

  it("activates all repos in the repositories array", async () => {
    await controller.handleInstallationCreated(
      installationCreatedPayload(11111, "alice", "User", ["alice/repo-a", "alice/repo-b"]),
    );
    const a = await Repo.findOrCreate("alice/repo-a");
    const b = await Repo.findOrCreate("alice/repo-b");
    expect(a.status).toBe("active");
    expect(b.status).toBe("active");
  });

  it("calls loadIssuesFromGithub", async () => {
    // Pre-create the repo so we can spy on its taskManager.
    const repo = await Repo.findOrCreate("alice/my-repo");
    const loadSpy = vi.spyOn(repo.taskManager, "loadIssuesFromGithub").mockResolvedValue(undefined);

    await controller.handleInstallationCreated(
      installationCreatedPayload(11111, "alice", "User", ["alice/my-repo"]),
    );

    expect(loadSpy).toHaveBeenCalled();
  });
});

// ── installation.created — Organization install ───────────────────────────────

describe("handleInstallationCreated — Organization target", () => {
  it("creates an Installation record", async () => {
    await controller.handleInstallationCreated(
      installationCreatedPayload(22222, "my-org", "Organization", ["my-org/repo-a"]),
    );
    const inst = await Installation.getByGithubId(22222);
    expect(inst).not.toBeNull();
    expect(inst!.accountType).toBe("Organization");
  });

  it("does not activate repos (lazy activation via worker connect)", async () => {
    await controller.handleInstallationCreated(
      installationCreatedPayload(22222, "my-org", "Organization", ["my-org/repo-a"]),
    );
    // Repo should not be created/activated; if it was created it should be inactive.
    const repo = await Repo.findOrCreate("my-org/repo-a");
    // The controller should NOT have activated this repo.
    // findOrCreate above would create it as "new" if it didn't already exist.
    // If the controller created it, it should still be "new".
    expect(repo.status).toBe("new");
  });
});

// ── installation.deleted ──────────────────────────────────────────────────────

describe("handleInstallationDeleted", () => {
  it("deletes the Installation record", async () => {
    const inst = await Installation.insert({
      github_id: 11111,
      account_login: "alice",
      account_type: "User",
    });

    await controller.handleInstallationDeleted(
      installationDeletedPayload(11111, "alice"),
    );

    expect(await Installation.get(inst.id)).toBeNull();
  });

  it("unlinks repos associated with the installation", async () => {
    const inst = await Installation.insert({
      github_id: 11111,
      account_login: "alice",
      account_type: "User",
    });
    const repo = await Repo.findOrCreate("alice/my-repo");
    await repo.linkInstallation(inst.id);
    await repo.activate();

    await controller.handleInstallationDeleted(
      installationDeletedPayload(11111, "alice"),
    );

    const updated = await Repo.get(repo.id);
    expect(updated!.installationId).toBeNull();
  });

  it("deactivates repos associated with the installation", async () => {
    const inst = await Installation.insert({
      github_id: 11111,
      account_login: "alice",
      account_type: "User",
    });
    const repo = await Repo.findOrCreate("alice/my-repo");
    await repo.linkInstallation(inst.id);
    await repo.activate();

    await controller.handleInstallationDeleted(
      installationDeletedPayload(11111, "alice"),
    );

    const updated = await Repo.get(repo.id);
    expect(updated!.status).toBe("new");
  });

  it("is a no-op when Installation record does not exist", async () => {
    await expect(
      controller.handleInstallationDeleted(installationDeletedPayload(99999, "nobody")),
    ).resolves.not.toThrow();
  });
});

// ── installation_repositories.added — User target ────────────────────────────

describe("handleReposAdded — User target", () => {
  it("activates and links newly-added repos", async () => {
    const inst = await Installation.insert({
      github_id: 11111,
      account_login: "alice",
      account_type: "User",
    });

    await controller.handleReposAdded(
      installationRepositoriesAddedPayload(11111, "alice", "User", ["alice/new-repo"]),
    );

    const repo = await Repo.findOrCreate("alice/new-repo");
    expect(repo.status).toBe("active");
    expect(repo.installationId).toBe(inst.id);
  });

  it("calls loadIssuesFromGithub", async () => {
    await Installation.insert({
      github_id: 11111,
      account_login: "alice",
      account_type: "User",
    });
    // Pre-create the repo so we can spy on its taskManager.
    const repo = await Repo.findOrCreate("alice/new-repo");
    const loadSpy = vi.spyOn(repo.taskManager, "loadIssuesFromGithub").mockResolvedValue(undefined);

    await controller.handleReposAdded(
      installationRepositoriesAddedPayload(11111, "alice", "User", ["alice/new-repo"]),
    );

    expect(loadSpy).toHaveBeenCalled();
  });
});

// ── installation_repositories.added — Org target ─────────────────────────────

describe("handleReposAdded — Organization target", () => {
  it("does not activate repos for org installs", async () => {
    await Installation.insert({
      github_id: 22222,
      account_login: "my-org",
      account_type: "Organization",
    });

    await controller.handleReposAdded(
      installationRepositoriesAddedPayload(22222, "my-org", "Organization", ["my-org/new-repo"]),
    );

    const repo = await Repo.findOrCreate("my-org/new-repo");
    expect(repo.status).toBe("new");
  });
});

// ── installation_repositories.removed ────────────────────────────────────────

describe("handleReposRemoved", () => {
  it("unlinks and deactivates removed repos", async () => {
    const inst = await Installation.insert({
      github_id: 11111,
      account_login: "alice",
      account_type: "User",
    });
    const repo = await Repo.findOrCreate("alice/my-repo");
    await repo.linkInstallation(inst.id);
    await repo.activate();

    await controller.handleReposRemoved(
      installationRepositoriesRemovedPayload(11111, "alice", ["alice/my-repo"]),
    );

    const updated = await Repo.get(repo.id);
    expect(updated!.status).toBe("new");
    expect(updated!.installationId).toBeNull();
  });

  it("silently skips repos that don't exist in the DB", async () => {
    await expect(
      controller.handleReposRemoved(
        installationRepositoriesRemovedPayload(11111, "alice", ["alice/ghost-repo"]),
      ),
    ).resolves.not.toThrow();
  });
});
