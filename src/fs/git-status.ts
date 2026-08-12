import { execFile } from "node:child_process";
import type { GitStatus } from "../types.js";

const GIT_TIMEOUT_MS = 3_000;

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(error ? "" : stdout.trim());
    });
  });
}

export async function getGitStatus(cwd: string | null): Promise<GitStatus | null> {
  if (!cwd) return null;
  const branch = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (!branch) return null;
  const [diffStat, statusPorcelain, ahead, behind] = await Promise.all([
    execGit(["diff", "--shortstat"], cwd),
    execGit(["status", "--porcelain"], cwd),
    execGit(["rev-list", "--count", "HEAD..@{u}"], cwd),
    execGit(["rev-list", "--count", "@{u}..HEAD"], cwd),
  ]);
  let additions = 0;
  let deletions = 0;
  const diffMatch = diffStat.match(/(\d+) insertions?/);
  const delMatch = diffStat.match(/(\d+) deletions?/);
  if (diffMatch) additions = Number(diffMatch[1]);
  if (delMatch) deletions = Number(delMatch[1]);
  const changedFiles = statusPorcelain ? statusPorcelain.split("\n").filter(Boolean).length : 0;
  return {
    branch,
    additions,
    deletions,
    changedFiles,
    ahead: ahead ? Number(ahead) || 0 : 0,
    behind: behind ? Number(behind) || 0 : 0,
  };
}
