import { describe, it, expect, beforeEach, vi } from "vitest";
import { Repo } from "../src/foreman/models/repo.js";
import { initDb } from "../src/foreman/clients/db-client.js";
import { createTestSupabase } from "./helpers/db.js";

const supabase = createTestSupabase();
initDb(supabase);

// Use a unique prefix to avoid collisions with other DB test files running in parallel.
const OWN_NAMES = ["dbr-owner/repo-a", "dbr-owner/repo-b"];

beforeEach(async () => {
  await supabase.from("repos").delete().in("full_name", OWN_NAMES);
});

describe("Repo.findOrCreate", () => {
  it("creates a new repo with status 'new'", async () => {
    const repo = await Repo.findOrCreate("dbr-owner/repo-a");
    expect(repo.fullName).toBe("dbr-owner/repo-a");
    expect(repo.status).toBe("new");
    expect(repo.id).toBeGreaterThan(0);
    expect(repo.createdAt).toBeTruthy();
  });

  it("is idempotent — calling twice returns the same row", async () => {
    const first = await Repo.findOrCreate("dbr-owner/repo-a");
    const second = await Repo.findOrCreate("dbr-owner/repo-a");
    expect(second.id).toBe(first.id);
    expect(second.fullName).toBe(first.fullName);
  });

  it("creates distinct rows for different full_names", async () => {
    const a = await Repo.findOrCreate("dbr-owner/repo-a");
    const b = await Repo.findOrCreate("dbr-owner/repo-b");
    expect(a.id).not.toBe(b.id);
  });

  it("does not emit 'changed' when the repo already exists", async () => {
    await Repo.findOrCreate("dbr-owner/repo-a");
    const listener = vi.fn();
    Repo.events.on("changed", listener);
    try {
      await Repo.findOrCreate("dbr-owner/repo-a");
      expect(listener).not.toHaveBeenCalled();
    } finally {
      Repo.events.off("changed", listener);
    }
  });

  it("emits 'changed' when a new repo is created", async () => {
    const listener = vi.fn();
    Repo.events.on("changed", listener);
    try {
      await Repo.findOrCreate("dbr-owner/repo-a");
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      Repo.events.off("changed", listener);
    }
  });
});

describe("Repo.get", () => {
  it("returns the repo by id", async () => {
    const created = await Repo.findOrCreate("dbr-owner/repo-a");
    const found = await Repo.get(created.id);
    expect(found).not.toBeNull();
    expect(found!.fullName).toBe("dbr-owner/repo-a");
  });

  it("returns null for unknown id", async () => {
    const found = await Repo.get(0);
    expect(found).toBeNull();
  });
});

describe("Repo.list", () => {
  it("returns repos including the ones just created", async () => {
    await Repo.findOrCreate("dbr-owner/repo-a");
    await Repo.findOrCreate("dbr-owner/repo-b");
    const all = await Repo.list();
    const ours = all.filter((r) => r.fullName.startsWith("dbr-owner/"));
    expect(ours).toHaveLength(2);
  });
});

describe("Repo.listActive", () => {
  it("returns only repos with status 'active'", async () => {
    const a = await Repo.findOrCreate("dbr-owner/repo-a");
    await Repo.findOrCreate("dbr-owner/repo-b");
    await supabase.from("repos").update({ status: "active" }).eq("id", a.id);

    const active = await Repo.listActive();
    const ours = active.filter((r) => r.fullName.startsWith("dbr-owner/"));
    expect(ours).toHaveLength(1);
    expect(ours[0].fullName).toBe("dbr-owner/repo-a");
  });

  it("returns empty when no repos are active", async () => {
    await Repo.findOrCreate("dbr-owner/repo-a");
    await Repo.findOrCreate("dbr-owner/repo-b");

    const active = await Repo.listActive();
    const ours = active.filter((r) => r.fullName.startsWith("dbr-owner/"));
    expect(ours).toHaveLength(0);
  });
});
