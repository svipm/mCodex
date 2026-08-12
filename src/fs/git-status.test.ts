import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { getGitStatus } from "./git-status.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

describe("getGitStatus", () => {
  it("returns branch, working-tree changes, and upstream delta", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcodex-git-"));
    tempDirs.push(root);
    await runGit(root, ["init", "-b", "main"]);
    await runGit(root, ["config", "user.email", "test@example.com"]);
    await runGit(root, ["config", "user.name", "Test"]);
    await writeFile(path.join(root, "a.txt"), "one\n");
    await runGit(root, ["add", "."]);
    await runGit(root, ["commit", "-m", "initial"]);
    await writeFile(path.join(root, "a.txt"), "one\ntwo\nthree\n");

    expect(await getGitStatus(root)).toEqual({
      branch: "main",
      additions: 2,
      deletions: 0,
      changedFiles: 1,
      ahead: 0,
      behind: 0,
    });
  });

  it("returns null for directories without a Git repo", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcodex-git-missing-"));
    tempDirs.push(root);
    expect(await getGitStatus(root)).toBeNull();
  });

  it("returns null when no working directory is available", async () => {
    expect(await getGitStatus(null)).toBeNull();
  });
});
