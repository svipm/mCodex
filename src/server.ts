import crypto from "node:crypto";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import compression from "compression";
import express, { type NextFunction, type Request, type Response } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { config } from "./config.js";
import { listDirectories, listRoots } from "./fs/folder-picker.js";
import { CodexCdpController, isCodexPermissionMode, isDesktopMode, isFollowUpMode, isReasoningEffort, type CodexImageInput, type CodexPermissionMode, type CdpStatus, type CodexPermissionState, type DesktopMode, type FollowUpMode, type ReasoningEffort } from "./cdp/controller.js";
import { SessionStore } from "./sessions/store.js";
import { SessionWatcher } from "./sessions/watcher.js";
import { reconcileRuntimeStatuses } from "./runtime-status.js";
import type { BridgeEvent, TimelineItem } from "./types.js";

class BadRequestError extends Error {}

export interface BridgeCdp {
  status(): Promise<CdpStatus>;
  streamingOutput(): Promise<unknown>;
  setDesktopMode(mode: DesktopMode): Promise<{ mode: DesktopMode | null }>;
  setReasoningEffort(effort: ReasoningEffort): Promise<{ effort: ReasoningEffort | null; label: string }>;
  setPermissionMode(mode: CodexPermissionMode): Promise<CodexPermissionState>;
  openThread(threadId: string): Promise<{ threadId: string }>;
  sendMessage(threadId: string, content: string, clientMessageId: string, images: CodexImageInput[]): Promise<unknown>;
  sendFollowUpMessage(threadId: string, content: string, mode: FollowUpMode, clientMessageId: string, images: CodexImageInput[]): Promise<unknown>;
  stopTask(threadId: string): Promise<unknown>;
  decideApproval(threadId: string, decision: "approve" | "reject"): Promise<unknown>;
  listProjects(): Promise<unknown>;
  createProject(name: string, rootPath: string): Promise<unknown>;
  createTask(projectId: string | null, content: string, clientMessageId: string, images: CodexImageInput[]): Promise<unknown>;
}

export interface BridgeWatcher {
  on(event: "event", listener: (event: BridgeEvent) => void): unknown;
  start(): Promise<void>;
  stop(): void;
}

export interface BridgeOptions {
  sessions?: SessionStore;
  cdp?: BridgeCdp;
  watcher?: BridgeWatcher;
  port?: number;
  token?: string;
  host?: string;
  webRoot?: string;
  pairingCode?: string;
  polling?: boolean;
}

const serverLocale = /^en(?:-|$)/i.test(process.env.MCODEX_LOCALE ?? "") || (!process.env.MCODEX_LOCALE && /^en(?:-|$)/i.test(Intl.DateTimeFormat().resolvedOptions().locale)) ? "en-US" : "zh-CN";
const serverText = (chinese: string, english: string): string => serverLocale === "en-US" ? english : chinese;

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().split("%")[0];
  return normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized) || /^::ffff:127(?:\.\d{1,3}){3}$/.test(normalized);
}

export function mayUseQueryToken(method: string, requestPath: string): boolean {
  return method.toUpperCase() === "GET" && requestPath === "/media";
}

export function deferInlineTimelineImages(items: TimelineItem[]): TimelineItem[] {
  return items.map((item) => {
    if (!item.images?.some((image) => image.source.startsWith("data:"))) return item;
    return {
      ...item,
      images: item.images.map((image, imageIndex) => {
        if (!image.source.startsWith("data:")) return image;
        const query = new URLSearchParams({ threadId: item.threadId, itemId: item.id, imageIndex: String(imageIndex) });
        return { ...image, source: `/api/media?${query}` };
      }),
    };
  });
}

function makeTokenMatcher(bridgeToken: string): (candidate: string) => boolean {
  if (!bridgeToken) return () => true;
  const expected = Buffer.from(bridgeToken);
  return (candidate) => {
    const actual = Buffer.from(candidate);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  };
}

function parseImageInputs(value: unknown): CodexImageInput[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 4) throw new BadRequestError("Images must be an array containing at most 4 files");
  return value.map((raw, index) => {
    const image = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const name = typeof image.name === "string" && image.name.trim() ? image.name.trim().slice(0, 180) : `image-${index + 1}.png`;
    const mimeType = image.mimeType;
    if (!(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"] as unknown[]).includes(mimeType)) {
      throw new BadRequestError("Images must use AVIF, GIF, JPEG, PNG, or WebP format");
    }
    const data = typeof image.data === "string" ? image.data : "";
    if (!data || !/^[a-zA-Z0-9+/]*={0,2}$/.test(data)) throw new BadRequestError("Image data is invalid");
    const buffer = Buffer.from(data, "base64");
    if (!buffer.length || buffer.length > 10 * 1024 * 1024) throw new BadRequestError("Each image must be 10 MB or smaller");
    return { name, mimeType: mimeType as CodexImageInput["mimeType"], buffer };
  });
}

export async function createBridge(options: BridgeOptions = {}) {
  const pairingCode = options.pairingCode ?? crypto.randomBytes(4).toString("hex").toUpperCase();
  let pairingAttempts = 0;
  const pairingExpiresAt = Date.now() + 10 * 60 * 1000;
  const sessions = options.sessions ?? new SessionStore(config.codexHome);
  const watcher = options.watcher ?? new SessionWatcher(config.codexHome, config.scanIntervalMs);
  const cdp: BridgeCdp = options.cdp ?? new CodexCdpController(config.cdpUrl, sessions);
  const tokenMatches = makeTokenMatcher(options.token ?? config.token);
  const auth: (req: Request, res: Response, next: NextFunction) => void = (req, res, next) => {
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    const queryToken = mayUseQueryToken(req.method, req.path) && typeof req.query.token === "string" ? req.query.token : "";
    if (!tokenMatches(bearer || queryToken)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };
  const port = options.port ?? config.port;
  const host = options.host ?? config.host;
  const enablePolling = options.polling ?? true;
  const app = express();
  app.disable("x-powered-by");
  app.use(compression({ threshold: 1_024 }));
  // Four 10 MB images expand to roughly 53.4 MB when encoded as Base64.
  app.use(express.json({ limit: "60mb" }));
  app.get("/api/health", (_req, res) => res.json({ ok: true, authRequired: Boolean(config.token), pairingAvailable: Boolean(config.external && Date.now() < pairingExpiresAt) }));
  app.get("/api/pairing-info", (req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.status(403).json({ error: "Pairing information is only available on this computer" });
      return;
    }
    const addresses = Object.values(os.networkInterfaces()).flatMap((entries) => entries ?? [])
      .filter((entry) => entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254."))
      .map((entry) => entry.address);
    const urls = [...new Set(addresses)].map((address) => {
      const url = new URL(`http://${address}:${config.port}/`);
      url.searchParams.set("pairing", pairingCode);
      return url.toString();
    });
    res.json({
      available: Boolean(config.external && Date.now() < pairingExpiresAt),
      expiresAt: pairingExpiresAt,
      pairingCode: config.external ? pairingCode : "",
      urls,
    });
  });
  app.post("/api/pair", (req, res) => {
    if (pairingAttempts >= 10) {
      res.status(429).json({ error: "Pairing temporarily locked; restart the Bridge to generate a new code" });
      return;
    }
    const code = typeof req.body?.code === "string" ? req.body.code.trim().toUpperCase() : "";
    pairingAttempts += 1;
    const expected = Buffer.from(pairingCode);
    const actual = Buffer.from(code);
    if (!config.external || Date.now() >= pairingExpiresAt || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      res.status(401).json({ error: "Invalid or expired pairing code" });
      return;
    }
    res.json({ token: config.token });
  });
  app.use("/api", auth);

  app.get("/api/status", async (_req, res) => {
    res.json({ cdp: await cdp.status(), codexHome: config.codexHome, pairing: { available: Boolean(config.external && Date.now() < pairingExpiresAt) } });
  });
  app.put("/api/mode", async (req, res, next) => {
    try {
      const mode: unknown = req.body?.mode;
      if (!isDesktopMode(mode)) return void res.status(400).json({ error: "Mode must be codex or chatgpt-work" });
      res.json(await cdp.setDesktopMode(mode));
    } catch (error) { next(error); }
  });
  app.put("/api/reasoning", async (req, res, next) => {
    try {
      const effort: unknown = req.body?.effort;
      if (!isReasoningEffort(effort)) return void res.status(400).json({ error: "Reasoning effort must be low, medium, high, or xhigh" });
      res.json(await cdp.setReasoningEffort(effort));
    } catch (error) { next(error); }
  });
  app.put("/api/permissions", async (req, res, next) => {
    try {
      const mode: unknown = req.body?.mode;
      if (!isCodexPermissionMode(mode)) return void res.status(400).json({ error: "Permission mode must be ask, auto, or full-access" });
      res.json(await cdp.setPermissionMode(mode as CodexPermissionMode));
    } catch (error) { next(error); }
  });
  app.get("/api/threads", async (_req, res, next) => {
    try {
      const [threads, runtime] = await Promise.all([sessions.listThreads(), cdp.status()]);
      res.json({ threads: reconcileRuntimeStatuses(threads, runtime), cdp: runtime });
    } catch (error) { next(error); }
  });
  app.get("/api/threads/:id/timeline", async (req, res, next) => {
    try {
      const file = await sessions.getThreadFile(req.params.id);
      if (!file) return void res.status(404).json({ error: "Thread not found" });
      const timeline = await sessions.getTimelineWithApprovals(req.params.id);
      res.json({ ...timeline, items: deferInlineTimelineImages(timeline.items) });
    } catch (error) { next(error); }
  });
  app.get("/api/threads/:id/environment", async (req, res, next) => {
    try {
      const file = await sessions.getThreadFile(req.params.id);
      if (!file) return void res.status(404).json({ error: "Thread not found" });
      const info = await sessions.getEnvironmentInfo(req.params.id);
      res.json(info ?? { git: null, tokenUsage: null, sources: [] });
    } catch (error) { next(error); }
  });
  app.get("/api/media", async (req, res, next) => {
    try {
      const threadId = typeof req.query.threadId === "string" ? req.query.threadId.trim() : "";
      const itemId = typeof req.query.itemId === "string" ? req.query.itemId.trim() : "";
      const imageIndex = typeof req.query.imageIndex === "string" ? Number(req.query.imageIndex) : -1;
      if (threadId && itemId && Number.isSafeInteger(imageIndex) && imageIndex >= 0) {
        const item = (await sessions.getTimeline(threadId)).find((candidate) => candidate.id === itemId);
        const source = item?.images?.[imageIndex]?.source ?? "";
        const match = /^data:(image\/(?:avif|gif|jpeg|png|webp));base64,([a-zA-Z0-9+/]*={0,2})$/.exec(source);
        if (!match) return void res.status(404).json({ error: "Image not found" });
        const buffer = Buffer.from(match[2], "base64");
        if (!buffer.length || buffer.length > 20 * 1024 * 1024) return void res.status(404).json({ error: "Image not found" });
        res.setHeader("Cache-Control", "private, max-age=3600");
        res.type(match[1]).send(buffer);
        return;
      }
      const requested = typeof req.query.path === "string" ? req.query.path.trim() : "";
      const mediaPath = requested.startsWith("file:") ? fileURLToPath(requested) : requested;
      if (!threadId || !await sessions.containsImageReference(threadId, requested)) {
        return void res.status(404).json({ error: "Image not found" });
      }
      if (!mediaPath || !path.isAbsolute(mediaPath) || !/\.(?:avif|gif|jpe?g|png|webp)$/i.test(mediaPath)) {
        return void res.status(400).json({ error: "An absolute image path is required" });
      }
      const mediaStat = await stat(mediaPath).catch(() => null);
      if (!mediaStat?.isFile() || mediaStat.size > 20 * 1024 * 1024) return void res.status(404).json({ error: "Image not found" });
      res.sendFile(path.resolve(mediaPath));
    } catch (error) { next(error); }
  });
  app.post("/api/threads/:id/open", async (req, res, next) => {
    try {
      if (!await sessions.getThreadFile(req.params.id)) return void res.status(404).json({ error: "Thread not found" });
      res.json(await cdp.openThread(req.params.id));
    } catch (error) { next(error); }
  });
  app.post("/api/threads/:id/send", async (req, res, next) => {
    try {
      const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
      const images = parseImageInputs(req.body?.images);
      const clientMessageId = typeof req.body?.clientMessageId === "string" ? req.body.clientMessageId : "";
      if ((!content && !images.length) || content.length > 100_000) return void res.status(400).json({ error: "A message or image is required, and text must not exceed 100000 characters" });
      if (!/^[0-9a-f-]{36}$/i.test(clientMessageId)) return void res.status(400).json({ error: "A UUID clientMessageId is required" });
      if (!await sessions.getThreadFile(req.params.id)) return void res.status(404).json({ error: "Thread not found" });
      res.json(await cdp.sendMessage(req.params.id, content, clientMessageId, images));
    } catch (error) { next(error); }
  });
  app.post("/api/threads/:id/follow-up", async (req, res, next) => {
    try {
      const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
      const images = parseImageInputs(req.body?.images);
      const mode: unknown = req.body?.mode;
      const clientMessageId = typeof req.body?.clientMessageId === "string" ? req.body.clientMessageId : "";
      if ((!content && !images.length) || content.length > 100_000) return void res.status(400).json({ error: "A message or image is required, and text must not exceed 100000 characters" });
      if (!isFollowUpMode(mode)) return void res.status(400).json({ error: "Follow-up mode must be queue, steer, or interrupt" });
      if (!/^[0-9a-f-]{36}$/i.test(clientMessageId)) return void res.status(400).json({ error: "A UUID clientMessageId is required" });
      if (!await sessions.getThreadFile(req.params.id)) return void res.status(404).json({ error: "Thread not found" });
      res.json(await cdp.sendFollowUpMessage(req.params.id, content, mode as FollowUpMode, clientMessageId, images));
    } catch (error) { next(error); }
  });
  app.post("/api/threads/:id/stop", async (req, res, next) => {
    try {
      if (!await sessions.getThreadFile(req.params.id)) return void res.status(404).json({ error: "Thread not found" });
      res.json(await cdp.stopTask(req.params.id));
    } catch (error) { next(error); }
  });
  app.post("/api/threads/:id/approval", async (req, res, next) => {
    try {
      const decision = req.body?.decision;
      if (decision !== "approve" && decision !== "reject") return void res.status(400).json({ error: "decision must be approve or reject" });
      if (!await sessions.getThreadFile(req.params.id)) return void res.status(404).json({ error: "Thread not found" });
      res.json(await cdp.decideApproval(req.params.id, decision));
    } catch (error) { next(error); }
  });
  app.get("/api/projects", async (_req, res, next) => {
    try { res.json(await cdp.listProjects()); } catch (error) { next(error); }
  });
  app.post("/api/projects", async (req, res, next) => {
    try {
      const requestedPath = typeof req.body?.rootPath === "string" ? req.body.rootPath.trim() : "";
      if (!requestedPath || requestedPath.length > 1_000 || !path.isAbsolute(requestedPath)) {
        return void res.status(400).json({ error: "An absolute project folder path is required" });
      }
      const rootPath = path.resolve(requestedPath);
      const rootStat = await stat(rootPath).catch(() => null);
      if (!rootStat?.isDirectory()) return void res.status(400).json({ error: "Project folder does not exist" });
      const requestedName = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      const name = requestedName || path.basename(rootPath);
      if (!name || name.length > 120 || /[\u0000-\u001f]/.test(name)) return void res.status(400).json({ error: "Project name is invalid" });
      res.json(await cdp.createProject(name, rootPath));
    } catch (error) { next(error); }
  });
  app.get("/api/fs/roots", async (_req, res, next) => {
    try { res.json(await listRoots()); } catch (error) { next(error); }
  });
  app.get("/api/fs/list", async (req, res, next) => {
    try {
      const dirPath = typeof req.query.path === "string" ? req.query.path.trim() : "";
      if (!dirPath || dirPath.length > 1_000 || !path.isAbsolute(dirPath)) {
        return void res.status(400).json({ error: "An absolute directory path is required" });
      }
      res.json(await listDirectories(path.resolve(dirPath)));
    } catch (error) { next(error); }
  });
  app.post("/api/tasks", async (req, res, next) => {
    try {
      const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
      const projectId = typeof req.body?.projectId === "string" && req.body.projectId.trim() ? req.body.projectId.trim() : null;
      const clientMessageId = typeof req.body?.clientMessageId === "string" ? req.body.clientMessageId : "";
      const images = parseImageInputs(req.body?.images);
      if ((!content && !images.length) || content.length > 100_000) return void res.status(400).json({ error: "A message or image is required, and text must not exceed 100000 characters" });
      if (!/^[0-9a-f-]{36}$/i.test(clientMessageId)) return void res.status(400).json({ error: "A UUID clientMessageId is required" });
      res.json(await cdp.createTask(projectId, content, clientMessageId, images));
    } catch (error) { next(error); }
  });

  const webRoot = options.webRoot ?? (process.env.BRIDGE_WEB_ROOT
    ? path.resolve(process.env.BRIDGE_WEB_ROOT)
    : path.resolve(process.cwd(), "dist/web"));
  app.use(express.static(webRoot));
  app.get("/*splat", (_req, res) => res.sendFile(path.join(webRoot, "index.html")));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(error);
    const badRequest = error instanceof BadRequestError;
    res.status(badRequest ? 400 : 500).json({ error: badRequest ? error.message : "Internal server error" });
  });

  const server = app.listen(port, host);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const wss = new WebSocketServer({ noServer: true });
  const websocketLiveness = new WeakMap<WebSocket, boolean>();
  wss.on("connection", (ws) => {
    websocketLiveness.set(ws, true);
    ws.on("pong", () => websocketLiveness.set(ws, true));
    ws.on("error", (error) => {
      console.error("WebSocket client error:", error instanceof Error ? error.message : String(error));
    });
    void cdp.status().then((status) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "desktop_state", status }));
    });
  });
  const websocketHeartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.readyState !== client.OPEN) continue;
      if (websocketLiveness.get(client) === false) {
        client.terminate();
        continue;
      }
      websocketLiveness.set(client, false);
      try { client.ping(); } catch { client.terminate(); }
    }
  }, 25_000);
  websocketHeartbeat.unref();
  const broadcast = (payload: unknown) => {
    const data = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState !== client.OPEN) continue;
      try { client.send(data); } catch { /* Ignore per-client send failures. */ }
    }
  };
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname !== "/ws" || !tokenMatches(url.searchParams.get("token") ?? "")) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });
  watcher.on("event", (event: BridgeEvent) => {
    broadcast({ type: "session_event", event });
  });
  let desktopPoll: NodeJS.Timeout | null = null;
  let desktopPollBusy = false;
  let lastDesktopState = "";
  if (enablePolling) {
    desktopPoll = setInterval(async () => {
      if (desktopPollBusy) return;
      desktopPollBusy = true;
      try {
        const status = await cdp.status();
        const serialized = JSON.stringify(status);
        if (serialized !== lastDesktopState) {
          lastDesktopState = serialized;
          broadcast({ type: "desktop_state", status });
        }
      } finally {
        desktopPollBusy = false;
      }
    }, 1_000);
    desktopPoll.unref();
  }
  let streamPoll: NodeJS.Timeout | null = null;
  let streamPollBusy = false;
  let lastStreamState = "";
  if (enablePolling) {
    streamPoll = setInterval(async () => {
      if (streamPollBusy) return;
      streamPollBusy = true;
      try {
        const output = await cdp.streamingOutput();
        const serialized = JSON.stringify(output);
        if (serialized !== lastStreamState) {
          lastStreamState = serialized;
          broadcast({ type: "stream_output", output });
        }
      } finally {
        streamPollBusy = false;
      }
    }, 250);
    streamPoll.unref();
  }
  let envPoll: NodeJS.Timeout | null = null;
  let envPollBusy = false;
  let lastEnvState = "";
  let lastEnvThreadId = "";
  if (enablePolling) {
    envPoll = setInterval(async () => {
      if (envPollBusy) return;
      envPollBusy = true;
      try {
        const status = await cdp.status();
        const threadId = status.currentThreadId;
        if (!threadId || threadId.startsWith("client-new-thread:")) { lastEnvThreadId = ""; lastEnvState = ""; return; }
        if (threadId !== lastEnvThreadId) { lastEnvState = ""; lastEnvThreadId = threadId; }
        const info = await sessions.getEnvironmentInfo(threadId);
        const serialized = JSON.stringify(info);
        if (serialized !== lastEnvState) {
          lastEnvState = serialized;
          broadcast({ type: "environment_info", threadId, info });
        }
      } catch { /* Environment polling failures are non-fatal. */ }
      finally { envPollBusy = false; }
    }, 5_000);
    envPoll.unref();
  }
  await watcher.start();
  if (config.external) {
    console.log(serverText(`手机配对码（有效期 10 分钟）：${pairingCode}`, `Phone pairing code (valid for 10 minutes): ${pairingCode}`));
    if (config.tokenGenerated) console.log(serverText(`Bridge 访问令牌：${config.token}`, `Bridge access token: ${config.token}`));
  }

  return {
    app,
    server,
    close: async () => {
      if (desktopPoll) clearInterval(desktopPoll);
      if (streamPoll) clearInterval(streamPoll);
      if (envPoll) clearInterval(envPoll);
      clearInterval(websocketHeartbeat);
      watcher.stop();
      for (const client of wss.clients) client.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
