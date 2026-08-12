import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "./store.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function initGitRepo(root: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(path.join(root, "tracked.txt"), "one\n");
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
}

describe("SessionStore thread titles", () => {
  it("reuses titles populated by the thread list", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcodex-store-"));
    temporaryRoots.push(root);
    const threadId = "11111111-1111-4111-8111-111111111111";
    const sessionDir = path.join(root, "sessions", "2026", "08", "10");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(path.join(sessionDir, `rollout-${threadId}.jsonl`), [
      JSON.stringify({ timestamp: "2026-08-10T00:00:00.000Z", type: "session_meta", payload: { id: threadId, cwd: root } }),
      JSON.stringify({ timestamp: "2026-08-10T00:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fallback title" }] } }),
      "",
    ].join("\n"));
    await writeFile(path.join(root, "session_index.jsonl"), `${JSON.stringify({ id: threadId, thread_name: "Cached title" })}\n`);

    const store = new SessionStore(root);
    expect((await store.listThreads())[0]?.title).toBe("Cached title");
    const listThreads = vi.spyOn(store, "listThreads");

    await expect(store.getThreadTitle(threadId)).resolves.toBe("Cached title");
    expect(listThreads).not.toHaveBeenCalled();
  });
});

describe("SessionStore environment info", () => {
  it("assembles Git, token, and source info and refreshes after session growth", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "mcodex-env-"));
    temporaryRoots.push(codexHome);
    const cwd = path.join(codexHome, "project");
    await mkdir(cwd, { recursive: true });
    await initGitRepo(cwd);

    const threadId = "22222222-2222-4222-8222-222222222222";
    const sessionDir = path.join(codexHome, "sessions", "2026", "08", "12");
    await mkdir(sessionDir, { recursive: true });
    const filePath = path.join(sessionDir, `rollout-${threadId}.jsonl`);
    await writeFile(filePath, [
      JSON.stringify({ timestamp: "2026-08-12T00:00:00.000Z", type: "session_meta", payload: { id: threadId, cwd } }),
      JSON.stringify({ timestamp: "2026-08-12T00:00:01.000Z", type: "event_msg", payload: { type: "token_count", input_tokens: 10, output_tokens: 5, total_tokens: 15, model: "gpt-5" } }),
      JSON.stringify({ timestamp: "2026-08-12T00:00:02.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "See https://example.com/source" }] } }),
      "",
    ].join("\n"));

    const store = new SessionStore(codexHome);
    const first = await store.getEnvironmentInfo(threadId);
    expect(first).toMatchObject({
      git: { branch: "main", changedFiles: 0 },
      tokenUsage: { inputTokens: 10, outputTokens: 5, model: "gpt-5" },
      sources: ["https://example.com/source"],
    });

    await appendFile(filePath, `${JSON.stringify({ timestamp: "2026-08-12T00:00:03.000Z", type: "event_msg", payload: { type: "token_count", input_tokens: 20, output_tokens: 8, total_tokens: 28, model: "gpt-5.2" } })}\n`);
    const second = await store.getEnvironmentInfo(threadId);
    expect(second?.tokenUsage).toMatchObject({ inputTokens: 20, outputTokens: 8, model: "gpt-5.2" });
  });

  it("returns null for an unknown thread", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "mcodex-env-missing-"));
    temporaryRoots.push(codexHome);
    const store = new SessionStore(codexHome);
    expect(await store.getEnvironmentInfo("missing-thread")).toBeNull();
  });
});
