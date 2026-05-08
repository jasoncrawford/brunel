import { describe, it, expect, beforeEach } from "vitest";
import { Installation } from "../src/foreman/models/installation.js";
import { Repo } from "../src/foreman/models/repo.js";
import { initDb } from "../src/foreman/clients/db-client.js";
import { createTestSupabase } from "./helpers/db.js";

const supabase = createTestSupabase();
initDb(supabase);

// Use unique values to avoid collisions with other DB test files running in parallel.
const OWN_GITHUB_IDS = [99001, 99002];
const OWN_REPO_NAMES = ["dbi-owner/repo-a"];

beforeEach(async () => {
  await supabase.from("repos").delete().in("full_name", OWN_REPO_NAMES);
  await supabase.from("installations").delete().in("github_id", OWN_GITHUB_IDS);
});

describe("Installation.get", () => {
  it("returns null for unknown id", async () => {
    const found = await Installation.get(0);
    expect(found).toBeNull();
  });

  it("creates and retrieves an installation by id", async () => {
    const inst = await Installation.insert({
      github_id: 99001,
      account_login: "my-org",
      account_type: "Organization",
    });
    expect(inst.id).toBeGreaterThan(0);
    expect(inst.githubId).toBe(99001);
    expect(inst.accountLogin).toBe("my-org");
    expect(inst.accountType).toBe("Organization");
    expect(inst.createdAt).toBeTruthy();

    const found = await Installation.get(inst.id);
    expect(found).not.toBeNull();
    expect(found!.githubId).toBe(99001);
    expect(found!.accountLogin).toBe("my-org");
  });
});

describe("Installation.getByGithubId", () => {
  it("finds an installation by GitHub id", async () => {
    const inst = await Installation.insert({
      github_id: 99001,
      account_login: "my-org",
      account_type: "Organization",
    });
    const found = await Installation.getByGithubId(99001);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(inst.id);
  });

  it("returns null when GitHub id not found", async () => {
    const found = await Installation.getByGithubId(0);
    expect(found).toBeNull();
  });
});

describe("Installation.list", () => {
  it("returns installations including ones just created", async () => {
    await Installation.insert({ github_id: 99001, account_login: "org-a", account_type: "Organization" });
    await Installation.insert({ github_id: 99002, account_login: "org-b", account_type: "Organization" });
    const all = await Installation.list();
    const ours = all.filter((i) => OWN_GITHUB_IDS.includes(i.githubId));
    expect(ours).toHaveLength(2);
  });
});

describe("Repo.installation getter", () => {
  it("returns null when repo has no installation", async () => {
    const repo = await Repo.findOrCreate("dbi-owner/repo-a");
    const inst = await repo.installation;
    expect(inst).toBeNull();
  });

  it("returns the installation when repo has one linked", async () => {
    const repo = await Repo.findOrCreate("dbi-owner/repo-a");
    const installation = await Installation.insert({
      github_id: 99001,
      account_login: "my-org",
      account_type: "Organization",
    });
    await supabase.from("repos").update({ installation_id: installation.id }).eq("id", repo.id);

    const updatedRepo = await Repo.get(repo.id);
    const inst = await updatedRepo!.installation;
    expect(inst).not.toBeNull();
    expect(inst!.githubId).toBe(99001);
    expect(inst!.accountLogin).toBe("my-org");
  });
});
