import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeEvent } from "./types.js";
import type { CdpStatus } from "./cdp/controller.js";
import { SessionStore } from "./sessions/store.js";
import { createBridge, type BridgeCdp, type BridgeWatcher } from "./server.js";

type Bridge = Awaited<ReturnType<typeof createBridge>>;

const tempRoots: string[] = [];
const bridges: Bridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close().catch(() => undefined)));
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fakeCdp(overrides: Partial<BridgeCdp> = {}): BridgeCdp {
  const offlineStatus: CdpStatus = {
    connected: false,
    editorReady: false,
    currentThreadId: null,
    runningThreadIds: [],
    stopReady: false,
    approval: null,
    permissions: { mode: null, label: null, available: false },
    mode: null,
    reasoningEffort: null,
  };
  return {
    status: vi.fn(async () => offlineStatus),
    streamingOutput: vi.fn(async () => null),
    setDesktopMode: vi.fn(async (mode) => ({ mode })),
    setReasoningEffort: vi.fn(async (effort) => ({ effort, label: effort })),
    setPermissionMode: vi.fn(async () => ({ mode: null, label: null, available: true })),
    openThread: vi.fn(async (threadId) => ({ threadId })),
    sendMessage: vi.fn(async () => ({})),
    sendFollowUpMessage: vi.fn(async () => ({})),
    stopTask: vi.fn(async () => ({})),
    decideApproval: vi.fn(async () => ({})),
    listProjects: vi.fn(async () => ({ projects: [], recentThreadIds: [] })),
    createProject: vi.fn(async () => ({})),
    createTask: vi.fn(async () => ({ threadId: "new-thread" })),
    ...overrides,
  };
}

function fakeWatcher(): BridgeWatcher {
  const events = new EventEmitter();
  return {
    on: (event, listener) => events.on(event, listener),
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
  };
}

async function startBridge(sessions: SessionStore, cdp: BridgeCdp, watcher: BridgeWatcher = fakeWatcher(), token?: string): Promise<string> {
  const bridge = await createBridge({ sessions, cdp, watcher, host: "127.0.0.1", port: 0, polling: false, ...(token ? { token } : {}) });
  bridges.push(bridge);
  const address = bridge.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function fakeWatcherWithEmit(): { watcher: BridgeWatcher; emit: (event: BridgeEvent) => void } {
  const events = new EventEmitter();
  return {
    watcher: {
      on: (event, listener) => events.on(event, listener),
      start: vi.fn(async () => undefined),
      stop: vi.fn(),
    },
    emit: (event) => events.emit("event", event),
  };
}

function openWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function openSocketWithMessages(url: string): Promise<{ socket: WebSocket; messages: string[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const messages: string[] = [];
    socket.on("message", (data) => messages.push(String(data)));
    socket.once("open", () => resolve({ socket, messages }));
    socket.once("error", reject);
  });
}

async function waitForMessageCount(socket: WebSocket, messages: string[], count: number): Promise<void> {
  while (messages.length < count) {
    await new Promise<void>((resolve) => socket.once("message", () => resolve()));
  }
}

async function writeSession(codexHome: string, threadId: string): Promise<string> {
  const sessionDir = path.join(codexHome, "sessions", "2026", "08", "12");
  await mkdir(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, `rollout-${threadId}.jsonl`);
  await writeFile(filePath, [
    JSON.stringify({ timestamp: "2026-08-12T00:00:00.000Z", type: "session_meta", payload: { id: threadId, cwd: null } }),
    JSON.stringify({ timestamp: "2026-08-12T00:00:01.000Z", type: "event_msg", payload: { type: "token_count", inputTokens: 12, outputTokens: 3, totalTokens: 15, model: "gpt-5" } }),
    JSON.stringify({ timestamp: "2026-08-12T00:00:02.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "See https://example.com/a" }] } }),
    "",
  ].join("\n"));
  return filePath;
}

describe("createBridge API integration", () => {
  it("rejects invalid mode and delegates valid mode changes", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "mcodex-bridge-mode-"));
    tempRoots.push(codexHome);
    const cdp = fakeCdp();
    const baseUrl = await startBridge(new SessionStore(codexHome), cdp);

    const invalid = await fetch(`${baseUrl}/api/mode`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "chatgpt" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "Mode must be codex or chatgpt-work" });
    expect(cdp.setDesktopMode).not.toHaveBeenCalled();

    const valid = await fetch(`${baseUrl}/api/mode`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "codex" }),
    });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ mode: "codex" });
    expect(cdp.setDesktopMode).toHaveBeenCalledWith("codex");
  });

  it("rejects invalid reasoning effort and delegates valid changes", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "mcodex-bridge-reasoning-"));
    tempRoots.push(codexHome);
    const cdp = fakeCdp();
    const baseUrl = await startBridge(new SessionStore(codexHome), cdp);

    const invalid = await fetch(`${baseUrl}/api/reasoning`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ effort: "max" }),
    });
    expect(invalid.status).toBe(400);
    expect(cdp.setReasoningEffort).not.toHaveBeenCalled();

    const valid = await fetch(`${baseUrl}/api/reasoning`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ effort: "high" }),
    });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ effort: "high", label: "high" });
    expect(cdp.setReasoningEffort).toHaveBeenCalledWith("high");
  });

  it("serves environment info from session records", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "mcodex-bridge-env-"));
    tempRoots.push(codexHome);
    const threadId = "33333333-3333-4333-8333-333333333333";
    await writeSession(codexHome, threadId);
    const baseUrl = await startBridge(new SessionStore(codexHome), fakeCdp());

    const response = await fetch(`${baseUrl}/api/threads/${threadId}/environment`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      git: null,
      tokenUsage: { inputTokens: 12, outputTokens: 3, model: "gpt-5" },
      sources: ["https://example.com/a"],
    });
  });

  it("returns 404 for an unknown thread environment", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "mcodex-bridge-env-missing-"));
    tempRoots.push(codexHome);
    const baseUrl = await startBridge(new SessionStore(codexHome), fakeCdp());

    const response = await fetch(`${baseUrl}/api/threads/99999999-9999-4999-8999-999999999999/environment`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Thread not found" });
  });

  it("reports health and status from the injected controller", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "mcodex-bridge-health-"));
    tempRoots.push(codexHome);
    const cdp = fakeCdp();
    const baseUrl = await startBridge(new SessionStore(codexHome), cdp);

    const health = await fetch(`${baseUrl}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });

    const status = await fetch(`${baseUrl}/api/status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ cdp: { connected: false, mode: null } });
  });

  it("serves timelines and returns 404 for unknown threads", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "mcodex-bridge-timeline-"));
    tempRoots.push(codexHome);
    const threadId = "44444444-4444-4444-8444-444444444444";
    await writeSession(codexHome, threadId);
    const baseUrl = await startBridge(new SessionStore(codexHome), fakeCdp());

    const response = await fetch(`${baseUrl}/api/threads/${threadId}/timeline`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ role: "assistant", text: "See https://example.com/a" });
    expect(body.approvals).toEqual([]);

    const missing = await fetch(`${baseUrl}/api/threads/99999999-9999-4999-8999-999999999999/timeline`);
    expect(missing.status).toBe(404);
  });

  it("validates and delegates message sends", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "mcodex-bridge-send-"));
    tempRoots.push(codexHome);
    const threadId = "55555555-5555-4555-8555-555555555555";
    const clientMessageId = "11111111-1111-4111-8111-111111111111";
    await writeSession(codexHome, threadId);
    const cdp = fakeCdp();
    const baseUrl = await startBridge(new SessionStore(codexHome), cdp);

    const empty = await fetch(`${baseUrl}/api/threads/${threadId}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "", clientMessageId }),
    });
    expect(empty.status).toBe(400);
    expect(cdp.sendMessage).not.toHaveBeenCalled();

    const valid = await fetch(`${baseUrl}/api/threads/${threadId}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello", clientMessageId }),
    });
    expect(valid.status).toBe(200);
    expect(cdp.sendMessage).toHaveBeenCalledWith(threadId, "hello", clientMessageId, []);
  });

  it("validates follow-up modes and delegates valid requests", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "mcodex-bridge-followup-"));
    tempRoots.push(codexHome);
    const threadId = "66666666-6666-4666-8666-666666666666";
    const clientMessageId = "11111111-1111-4111-8111-111111111111";
    await writeSession(codexHome, threadId);
    const cdp = fakeCdp();
    const baseUrl = await startBridge(new SessionStore(codexHome), cdp);

    const invalid = await fetch(`${baseUrl}/api/threads/${threadId}/follow-up`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "next", mode: "custom", clientMessageId }),
    });
    expect(invalid.status).toBe(400);
    expect(cdp.sendFollowUpMessage).not.toHaveBeenCalled();

    const valid = await fetch(`${baseUrl}/api/threads/${threadId}/follow-up`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "next", mode: "queue", clientMessageId }),
    });
    expect(valid.status).toBe(200);
    expect(cdp.sendFollowUpMessage).toHaveBeenCalledWith(threadId, "next", "queue", clientMessageId, []);
  });

  it("returns 404 for unknown stops and delegates existing ones", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "mcodex-bridge-stop-"));
    tempRoots.push(codexHome);
    const threadId = "77777777-7777-4777-8777-777777777777";
    await writeSession(codexHome, threadId);
    const cdp = fakeCdp();
    const baseUrl = await startBridge(new SessionStore(codexHome), cdp);

    const missing = await fetch(`${baseUrl}/api/threads/99999999-9999-4999-8999-999999999999/stop`, { method: "POST" });
    expect(missing.status).toBe(404);

    const valid = await fetch(`${baseUrl}/api/threads/${threadId}/stop`, { method: "POST" });
    expect(valid.status).toBe(200);
    expect(cdp.stopTask).toHaveBeenCalledWith(threadId);
  });

  it("validates approval decisions and delegates valid ones", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "mcodex-bridge-approval-"));
    tempRoots.push(codexHome);
    const threadId = "88888888-8888-4888-8888-888888888888";
    await writeSession(codexHome, threadId);
    const cdp = fakeCdp();
    const baseUrl = await startBridge(new SessionStore(codexHome), cdp);

    const invalid = await fetch(`${baseUrl}/api/threads/${threadId}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "maybe" }),
    });
    expect(invalid.status).toBe(400);
    expect(cdp.decideApproval).not.toHaveBeenCalled();

    const valid = await fetch(`${baseUrl}/api/threads/${threadId}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(valid.status).toBe(200);
    expect(cdp.decideApproval).toHaveBeenCalledWith(threadId, "approve");
  });

  it("validates and delegates task creation", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "mcodex-bridge-task-"));
    tempRoots.push(codexHome);
    const clientMessageId = "11111111-1111-4111-8111-111111111111";
    const cdp = fakeCdp();
    const baseUrl = await startBridge(new SessionStore(codexHome), cdp);

    const empty = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "", clientMessageId }),
    });
    expect(empty.status).toBe(400);
    expect(cdp.createTask).not.toHaveBeenCalled();

    const valid = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "do it", clientMessageId }),
    });
    expect(valid.status).toBe(200);
    expect(cdp.createTask).toHaveBeenCalledWith(null, "do it", clientMessageId);
  });

  it("serves projects and creates them after validation", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "mcodex-bridge-projects-"));
    tempRoots.push(codexHome);
    const cdp = fakeCdp();
    const baseUrl = await startBridge(new SessionStore(codexHome), cdp);

    const listed = await fetch(`${baseUrl}/api/projects`);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ projects: [], recentThreadIds: [] });

    const invalid = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Demo", rootPath: "relative/path" }),
    });
    expect(invalid.status).toBe(400);
    expect(cdp.createProject).not.toHaveBeenCalled();

    const valid = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Demo", rootPath: codexHome }),
    });
    expect(valid.status).toBe(200);
    expect(cdp.createProject).toHaveBeenCalledWith("Demo", path.resolve(codexHome));
  });

  it("requires the bridge token for API and WebSocket access", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "mcodex-bridge-auth-"));
    tempRoots.push(codexHome);
    const token = "test-token-1234567890abcdefghij";
    const baseUrl = await startBridge(new SessionStore(codexHome), fakeCdp(), fakeWatcher(), token);
    const port = new URL(baseUrl).port;

    const unauthorized = await fetch(`${baseUrl}/api/status`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${baseUrl}/api/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authorized.status).toBe(200);

    await expect(openWebSocket(`ws://127.0.0.1:${port}/ws`)).rejects.toThrow();
    const socket = await openWebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    socket.close();
  });

  it("pushes desktop state and session events over WebSocket", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "mcodex-bridge-ws-"));
    tempRoots.push(codexHome);
    const { watcher, emit } = fakeWatcherWithEmit();
    const baseUrl = await startBridge(new SessionStore(codexHome), fakeCdp(), watcher);
    const port = new URL(baseUrl).port;
    const { socket, messages } = await openSocketWithMessages(`ws://127.0.0.1:${port}/ws`);
    await waitForMessageCount(socket, messages, 1);
    const desktop = JSON.parse(messages[0]);
    expect(desktop.type).toBe("desktop_state");
    expect(desktop.status).toMatchObject({ connected: false });

    emit({ id: "event-1", threadId: "thread-1", timestamp: "2026-08-12T00:00:00.000Z", item: null });
    await waitForMessageCount(socket, messages, 2);
    const event = JSON.parse(messages[1]);
    expect(event.type).toBe("session_event");
    expect(event.event).toMatchObject({ threadId: "thread-1" });
    socket.close();
  });
});
