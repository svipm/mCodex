import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { chromium, type Browser, type Page } from "playwright-core";
import { normalizeText, SessionStore } from "../sessions/store.js";
import type { ApprovalDecision, ApprovalRequest } from "../types.js";

export interface CdpStatus {
  connected: boolean;
  currentThreadId: string | null;
  runningThreadIds: string[];
  editorReady: boolean;
  stopReady: boolean;
  approval: ApprovalRequest | null;
  permissions: CodexPermissionState;
  mode: DesktopMode | null;
  reasoningEffort: ReasoningEffort | null;
  model: string | null;
  error?: string;
}

export interface StreamingOutput {
  threadId: string;
  text: string;
}

export interface StreamingCandidate {
  identity: string;
  content: string;
}

export type CodexPermissionMode = "ask" | "auto" | "full-access";

export type FollowUpMode = "queue" | "steer" | "interrupt";

export type DesktopMode = "codex" | "chatgpt-work";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface CodexImageInput {
  name: string;
  mimeType: "image/avif" | "image/gif" | "image/jpeg" | "image/png" | "image/webp";
  buffer: Buffer;
}

export interface CodexPermissionState {
  mode: CodexPermissionMode | null;
  label: string | null;
  available: boolean;
}

const permissionOptionIndex: Record<CodexPermissionMode, number> = {
  ask: 0,
  auto: 1,
  "full-access": 2,
};

export function permissionModeFromLabel(label: string | null): CodexPermissionMode | null {
  const normalized = (label ?? "").replace(/[\s\p{P}\p{S}]+/gu, "").toLocaleLowerCase();
  if (!normalized) return null;
  if (/完全访问|完整访问|完整存取|fullaccess/.test(normalized)) return "full-access";
  if (/替我审|替我批|代我核|approveforme|reviewforme|autoreview/.test(normalized)) return "auto";
  if (/请求批|请求核|askforapproval|requestapproval/.test(normalized)) return "ask";
  return null;
}

export function isCodexPermissionMode(value: unknown): value is CodexPermissionMode {
  return value === "ask" || value === "auto" || value === "full-access";
}

export function isFollowUpMode(value: unknown): value is FollowUpMode {
  return value === "queue" || value === "steer" || value === "interrupt";
}

export function isDesktopMode(value: unknown): value is DesktopMode {
  return value === "codex" || value === "chatgpt-work";
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function reasoningEffortLabel(effort: ReasoningEffort): string {
  if (effort === "low") return "轻度";
  if (effort === "high") return "高";
  if (effort === "xhigh") return "极高";
  return "中";
}

export function shouldUseAlternateFollowUpShortcut(configuredMode: unknown, requestedMode: "queue" | "steer"): boolean {
  // Desktop treats a missing (or legacy "interrupt") preference as "steer".
  const activeMode = configuredMode === "queue" ? "queue" : "steer";
  return activeMode !== requestedMode;
}

export function selectCurrentStreamingText(candidates: StreamingCandidate[]): string {
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (!candidate) continue;
    if (/(?:^|[-_: ])(?:user|you)(?:$|[-_: ])/i.test(candidate.identity)) return "";
    const content = candidate.content.trim();
    if (content) return content;
  }
  return "";
}

export interface CodexProject {
  id: string;
  name: string;
  rootPaths: string[];
  threadIds: string[];
}

export interface CodexProjectCatalog {
  projects: CodexProject[];
  recentThreadIds: string[];
}

export function selectRecentThreadIds(sidebarThreadIds: string[], assignedThreadIds: string[]): string[] {
  const assigned = new Set(assignedThreadIds.map((threadId) => threadId.replace(/^local:/, "")));
  return [...new Set(sidebarThreadIds
    .map((threadId) => threadId.replace(/^local:/, ""))
    .filter((threadId) => threadId && !threadId.startsWith("client-new-thread:") && !assigned.has(threadId)))];
}

interface ThreadProjectAssignment {
  projectKind?: string;
  projectId?: string;
}

interface MessageReceipt {
  threadId: string;
  acceptedAt: string;
  confirmed: boolean;
}

export interface RunningRow {
  id: string;
  title: string;
}

export function resolveRunningThreadIds(
  runningRows: RunningRow[],
  threads: Array<{ id: string; title: string }>,
  currentThreadId: string | null,
): string[] {
  const normalized = (value: string) => value.replace(/\s+/g, "").toLocaleLowerCase();
  const resolved: string[] = [];
  for (const row of runningRows) {
    if (!row.id.startsWith("client-new-thread:")) {
      resolved.push(row.id);
      continue;
    }
    const rowTitle = normalized(row.title);
    let match = currentThreadId && !currentThreadId.startsWith("client-new-thread:")
      ? threads.find((thread) => thread.id === currentThreadId && (normalized(thread.title) === rowTitle || normalized(thread.title).startsWith(rowTitle.slice(0, 12)) || rowTitle.startsWith(normalized(thread.title).slice(0, 12))))
      : undefined;
    if (!match && rowTitle) {
      match = threads.find((thread) => {
        const title = normalized(thread.title);
        return title === rowTitle || title.startsWith(rowTitle.slice(0, 16)) || rowTitle.startsWith(title.slice(0, 16));
      });
    }
    if (match) resolved.push(match.id);
    else if (currentThreadId && !currentThreadId.startsWith("client-new-thread:")) resolved.push(currentThreadId);
  }
  return [...new Set(resolved)];
}

export class CodexCdpController {
  private browser: Browser | null = null;
  private controlChain: Promise<unknown> = Promise.resolve();
  private readonly receipts = new Map<string, MessageReceipt>();
  private statusSnapshot: { value: CdpStatus; capturedAt: number } | null = null;
  private statusInFlight: Promise<CdpStatus> | null = null;

  constructor(private readonly endpoint: string, private readonly sessions: SessionStore) {}

  private async connect(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.browser = await chromium.connectOverCDP(this.endpoint);
    this.browser.on("disconnected", () => { this.browser = null; });
    return this.browser;
  }

  private async mainPage(): Promise<Page> {
    const browser = await this.connect();
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.find((candidate) => candidate.url().startsWith("app://-/index.html?initialRoute=%2Flocal%2F"))
      ?? pages.find((candidate) => candidate.url() === "app://-/index.html");
    if (!page) throw new Error("Codex main page was not found on the CDP endpoint");
    return page;
  }

  private async currentThreadId(page: Page): Promise<string | null> {
    return page.locator("[data-above-composer-conversation-id]").first().getAttribute("data-above-composer-conversation-id").catch(() => null);
  }

  private runExclusive<T>(job: () => Promise<T>): Promise<T> {
    const result = this.controlChain.then(job, job);
    this.controlChain = result.catch(() => undefined);
    return result;
  }

  async status(): Promise<CdpStatus> {
    if (this.statusSnapshot && Date.now() - this.statusSnapshot.capturedAt < 400) return this.statusSnapshot.value;
    if (this.statusInFlight) return this.statusInFlight;
    this.statusInFlight = this.readStatus();
    try {
      const value = await this.statusInFlight;
      this.statusSnapshot = { value, capturedAt: Date.now() };
      return value;
    } finally {
      this.statusInFlight = null;
    }
  }

  private async readStatus(): Promise<CdpStatus> {
    try {
      const page = await this.mainPage();
      const [currentThreadId, stopReady, runningRows, editorReady, approval, permissions, mode, reasoningEffort, model] = await Promise.all([
        this.currentThreadId(page),
        this.stopButton(page).count().then((count) => count > 0),
        page.evaluate(() => Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"))
          .map((row) => ({
            id: (row.getAttribute("data-app-action-sidebar-thread-id") ?? "").replace(/^local:/, ""),
            spinning: Boolean(row.querySelector(".animate-spin")),
            title: (row.textContent ?? "").replace(/\s+/g, " ").trim(),
          }))
          .filter((row) => row.id && row.spinning)),
        page.locator('[contenteditable="true"][role="textbox"]').count().then((count) => count === 1),
        this.detectDesktopApproval(page),
        this.permissionStateFromPage(page),
        this.desktopModeFromPage(page),
        this.reasoningEffortFromPage(page),
        this.modelFromPage(page),
      ]);
      const threads = runningRows.some((row) => row.id.startsWith("client-new-thread:"))
        ? await this.sessions.listThreads()
        : [];
      const runningThreadIds = resolveRunningThreadIds(runningRows, threads, currentThreadId);
      if ((stopReady || runningRows.length > 0) && currentThreadId && !currentThreadId.startsWith("client-new-thread:") && !runningThreadIds.includes(currentThreadId)) {
        // Desktop may keep a temporary client-new-thread id in the sidebar while the composer already points at the real thread.
        const currentSpinning = runningRows.some((row) => row.id === currentThreadId || row.id.startsWith("client-new-thread:"));
        if (stopReady || currentSpinning) runningThreadIds.push(currentThreadId);
      }
      return {
        connected: true,
        currentThreadId: currentThreadId && !currentThreadId.startsWith("client-new-thread:") ? currentThreadId : (runningThreadIds[0] ?? currentThreadId),
        runningThreadIds: [...new Set(runningThreadIds)],
        editorReady,
        stopReady,
        approval,
        permissions,
        mode,
        reasoningEffort,
        model,
      };
    } catch (error) {
      return {
        connected: false,
        currentThreadId: null,
        runningThreadIds: [],
        editorReady: false,
        stopReady: false,
        approval: null,
        permissions: { mode: null, label: null, available: false },
        mode: null,
        reasoningEffort: null,
        model: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async streamingOutput(): Promise<StreamingOutput | null> {
    try {
      const page = await this.mainPage();
      const threadId = await this.currentThreadId(page);
      if (!threadId || threadId.startsWith("client-new-thread:") || await this.stopButton(page).count() === 0) return null;
      const candidates = await page.evaluate(() => {
        return Array.from(document.querySelectorAll<HTMLElement>("[data-content-search-unit-key]"))
          .filter((node) => node.getClientRects().length > 0)
          .map((node) => {
            const roleNode = node.closest<HTMLElement>("[data-message-author-role], [data-message-role], [data-role]")
              ?? node.querySelector<HTMLElement>("[data-message-author-role], [data-message-role], [data-role]");
            const markdown = node.matches('[class*="markdown"]') ? node : node.querySelector<HTMLElement>('[class*="markdown"]');
            return {
              identity: [
                node.getAttribute("data-content-search-unit-key"),
                roleNode?.getAttribute("data-message-author-role"),
                roleNode?.getAttribute("data-message-role"),
                roleNode?.getAttribute("data-role"),
                roleNode?.getAttribute("aria-label"),
              ].filter(Boolean).join(" "),
              content: markdown?.innerText ?? "",
            };
          });
      });
      const text = selectCurrentStreamingText(candidates);
      return text ? { threadId, text } : null;
    } catch {
      return null;
    }
  }



  private openDeepLink(threadId: string): void {
    if (process.platform !== "win32") throw new Error("Opening Codex thread deep links is currently implemented for Windows only");
    const child = spawn("explorer.exe", [`codex://threads/${threadId}`], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  }

  private async ensureThread(page: Page, threadId: string): Promise<void> {
    if (await this.currentThreadId(page) === threadId) return;
    const startedAt = Date.now();
    const remaining = () => Math.max(1, 6_000 - (Date.now() - startedAt));
    const waitForTarget = (timeout: number) => this.waitForCurrentThread(page, threadId, Math.min(timeout, remaining()));

    const row = page.locator(`[data-app-action-sidebar-thread-id="local:${threadId}"]:visible`);
    if (await row.count() === 1) {
      try {
        await row.evaluate((element: HTMLElement) => element.click(), undefined, { timeout: Math.min(1_000, remaining()) });
        await waitForTarget(1_500);
        return;
      } catch {
        // The sidebar can collapse while a task is being selected; fall through to search.
      }
    }
    if (await this.currentThreadId(page) === threadId) return;

    const title = await this.sessions.getThreadTitle(threadId);
    const searchButton = page.locator('button[aria-label="搜索"]:visible, button[aria-label="Search"]:visible');
    if (title && await searchButton.count() === 1 && remaining() > 1) {
      try {
        await searchButton.evaluate((element: HTMLElement) => element.click(), undefined, { timeout: Math.min(1_000, remaining()) });
        const searchInput = page.locator('input[cmdk-input][placeholder="搜索任务"], input[cmdk-input][placeholder*="Search" i]');
        await searchInput.waitFor({ state: "visible", timeout: Math.min(1_000, remaining()) });
        await searchInput.fill(title, { timeout: Math.min(1_000, remaining()) });
        const result = page.locator(`[cmdk-item][data-value="command-menu-quick-chat-result:local:${threadId}"]`);
        await result.waitFor({ state: "visible", timeout: Math.min(1_500, remaining()) });
        await result.evaluate((element: HTMLElement) => element.click(), undefined, { timeout: Math.min(1_000, remaining()) });
        await waitForTarget(2_500);
        return;
      } catch {
        await page.keyboard.press("Escape").catch(() => undefined);
      }
    }
    if (await this.currentThreadId(page) === threadId) return;

    if (remaining() <= 1) throw new Error("Codex task navigation timed out");
    this.openDeepLink(threadId);
    await waitForTarget(3_000);
  }

  private async waitForCurrentThread(page: Page, threadId: string, timeout = 8_000): Promise<void> {
    await page.waitForFunction((id) => document.querySelector("[data-above-composer-conversation-id]")?.getAttribute("data-above-composer-conversation-id") === id, threadId, { timeout });
  }

  private async hostRequest<T>(page: Page, command: string, params: unknown): Promise<T> {
    return await page.evaluate(async ({ command: hostCommand, params: hostParams }) => {
      const bridge = (window as any).electronBridge;
      if (!bridge?.sendMessageFromView) throw new Error("Codex desktop bridge is unavailable");
      const requestId = crypto.randomUUID();
      return await new Promise<T>((resolve, reject) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("Codex desktop request timed out"));
        }, 8_000);
        window.addEventListener("message", (event: MessageEvent) => {
          const message = event.data;
          if (message?.type !== "fetch-response" || message.requestId !== requestId) return;
          clearTimeout(timeout);
          controller.abort();
          if (message.responseType !== "success" || message.status < 200 || message.status >= 300) {
            reject(new Error(message.error ?? message.bodyJsonString ?? `Host request failed (${message.status})`));
            return;
          }
          try {
            const parsed = JSON.parse(message.bodyJsonString || "null");
            resolve(parsed as T);
          } catch (error) {
            reject(error);
          }
        }, { signal: controller.signal });
        bridge.sendMessageFromView({
          type: "fetch",
          requestId,
          method: "POST",
          url: `vscode://codex/${hostCommand}`,
          body: JSON.stringify(hostParams),
        }).catch((error: unknown) => {
          clearTimeout(timeout);
          controller.abort();
          reject(error);
        });
      });
    }, { command, params });
  }

  private async getGlobalState<T>(page: Page, key: string): Promise<T | null> {
    const response = await this.hostRequest<{ value?: T }>(page, "get-global-state", { key });
    return response.value ?? null;
  }

  private async setGlobalState(page: Page, key: string, value: unknown): Promise<void> {
    const response = await this.hostRequest<{ success?: boolean }>(page, "set-global-state", { key, value });
    if (response.success !== true) throw new Error(`Failed to update Codex desktop state: ${key}`);
  }

  private permissionTrigger(page: Page) {
    return page.locator('button[data-composer-navigation-target="permissions"]:visible').first();
  }

  private async permissionStateFromPage(page: Page): Promise<CodexPermissionState> {
    const trigger = this.permissionTrigger(page);
    if (await trigger.count() !== 1) return { mode: null, label: null, available: false };
    const label = (await trigger.innerText().catch(() => "")).replace(/\s+/g, " ").trim() || null;
    return { mode: permissionModeFromLabel(label), label, available: true };
  }

  private desktopModeTrigger(page: Page) {
    return page.locator('button[aria-label^="切换模式"]:visible').first();
  }

  private async desktopModeFromPage(page: Page): Promise<DesktopMode | null> {
    const trigger = this.desktopModeTrigger(page);
    if (await trigger.count() !== 1) return null;
    const label = (await trigger.getAttribute("aria-label")) ?? "";
    if (/chatgpt work/i.test(label)) return "chatgpt-work";
    if (/codex/i.test(label)) return "codex";
    return null;
  }

  private reasoningTrigger(page: Page) {
    return page.locator('[data-composer-navigation-target="reasoning"]:visible').first();
  }

  private async reasoningEffortFromPage(page: Page): Promise<ReasoningEffort | null> {
    const trigger = this.reasoningTrigger(page);
    if (await trigger.count() !== 1) return null;
    const effort = await trigger.getAttribute("data-selected-reasoning-effort");
    return isReasoningEffort(effort) ? effort : null;
  }

  private async modelFromPage(page: Page): Promise<string | null> {
    const trigger = this.reasoningTrigger(page);
    if (await trigger.count() !== 1) return null;
    const text = (await trigger.textContent()) ?? "";
    const model = text.replace(/\s*(?:极高|高|中|低|X-High|High|Medium|Light)\s*$/i, "").trim();
    return model || null;
  }

  async setDesktopMode(mode: DesktopMode): Promise<{ mode: DesktopMode | null }> {
    return this.runExclusive(async () => {
      const page = await this.mainPage();
      const trigger = this.desktopModeTrigger(page);
      if (await trigger.count() !== 1) throw new Error("Codex mode switch is unavailable");
      if (await this.desktopModeFromPage(page) === mode) return { mode };

      await trigger.click();
      const option = page.getByRole("menuitem", { name: mode === "codex" ? /^Codex\b/i : /^ChatGPT Work\b/i }).first();
      await option.waitFor({ state: "visible", timeout: 3_000 });
      await option.click();

      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const updated = await this.desktopModeFromPage(page);
        if (updated === mode) return { mode: updated };
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Codex mode did not change to the requested value");
    });
  }

  async setReasoningEffort(effort: ReasoningEffort): Promise<{ effort: ReasoningEffort | null; label: string }> {
    return this.runExclusive(async () => {
      const page = await this.mainPage();
      const trigger = this.reasoningTrigger(page);
      if (await trigger.count() !== 1) throw new Error("Codex reasoning control is unavailable");
      const current = await trigger.getAttribute("data-selected-reasoning-effort");
      const label = reasoningEffortLabel(effort);
      if (current === effort) return { effort: current as ReasoningEffort, label };

      await trigger.click();
      const submenu = page.getByRole("menuitem", { name: /推理强度|Reasoning effort/i }).first();
      await submenu.waitFor({ state: "visible", timeout: 3_000 });
      await submenu.click();

      const option = page.getByRole("menuitem", { name: label, exact: true }).last();
      await option.waitFor({ state: "visible", timeout: 3_000 });
      await option.click();
      await page.keyboard.press("Escape").catch(() => undefined);

      const updated = await trigger.getAttribute("data-selected-reasoning-effort");
      if (!isReasoningEffort(updated) || updated !== effort) throw new Error("Codex reasoning effort did not change to the requested value");
      return { effort: updated, label };
    });
  }

  async setPermissionMode(mode: CodexPermissionMode): Promise<CodexPermissionState> {
    return this.runExclusive(async () => {
      const page = await this.mainPage();
      const current = await this.permissionStateFromPage(page);
      if (!current.available) throw new Error("Codex permission control is unavailable");
      if (current.mode === mode) return current;

      const trigger = this.permissionTrigger(page);
      await trigger.click();
      const options = page.locator('[role="menuitem"]:visible');
      await options.first().waitFor({ state: "visible", timeout: 3_000 });
      if (await options.count() < 3) {
        await page.keyboard.press("Escape").catch(() => undefined);
        throw new Error("Codex permission options are unavailable");
      }

      const optionPatterns: Record<CodexPermissionMode, RegExp> = {
        ask: /请求批准|请求核准|ask\s+for\s+approval|request\s+approval/i,
        auto: /替我审批|替我批准|代我核准|approve\s+for\s+me|review\s+for\s+me|auto[- ]review/i,
        "full-access": /完全访问|完整访问|完整存取|full\s+access/i,
      };
      const matchingOption = options.filter({ hasText: optionPatterns[mode] }).first();
      const option = await matchingOption.count() === 1
        ? matchingOption
        : options.nth(Math.max(0, (await options.count()) - 3) + permissionOptionIndex[mode]);
      const disabled = await option.getAttribute("aria-disabled") === "true" || await option.getAttribute("data-disabled") !== null;
      if (disabled) {
        await page.keyboard.press("Escape").catch(() => undefined);
        throw new Error("The requested Codex permission mode is disabled by Desktop policy");
      }

      const visibleDialogsBefore = await page.locator('[role="dialog"]:visible').count();
      await option.click();
      if (mode === "full-access") {
        const dialog = page.locator('[role="dialog"]:visible').last();
        await dialog.waitFor({ state: "visible", timeout: 1_500 }).catch(() => undefined);
        if (await page.locator('[role="dialog"]:visible').count() > visibleDialogsBefore) {
          const confirm = dialog.locator('button:visible:not([disabled])').last();
          if (await confirm.count() !== 1) throw new Error("Codex full access confirmation is unavailable");
          await confirm.click();
        }
      }

      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const updated = await this.permissionStateFromPage(page);
        if (updated.mode === mode) return updated;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Codex permission mode did not change to the requested value");
    });
  }

  private async projectCatalogFromPage(page: Page): Promise<CodexProjectCatalog> {
    const [projects, order, assignments, sidebarThreadIds] = await Promise.all([
      this.getGlobalState<Record<string, Omit<CodexProject, "threadIds">>>(page, "local-projects"),
      this.getGlobalState<string[]>(page, "project-order"),
      this.getGlobalState<Record<string, ThreadProjectAssignment>>(page, "thread-project-assignments"),
      page.evaluate(() => Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"))
        .filter((row) => row.getClientRects().length > 0)
        .map((row) => row.getAttribute("data-app-action-sidebar-thread-id") ?? "")
        .filter(Boolean)),
    ]);
    const orderIndex = new Map((order ?? []).map((projectId, index) => [projectId, index]));
    const threadIdsByProject = new Map<string, string[]>();
    for (const [threadId, assignment] of Object.entries(assignments ?? {})) {
      if (!assignment || assignment.projectKind !== "local" || typeof assignment.projectId !== "string") continue;
      const threadIds = threadIdsByProject.get(assignment.projectId) ?? [];
      threadIds.push(threadId.replace(/^local:/, ""));
      threadIdsByProject.set(assignment.projectId, threadIds);
    }

    const projectList = Object.values(projects ?? {})
      .filter((project) => project && typeof project.id === "string" && typeof project.name === "string" && Array.isArray(project.rootPaths))
      .map((project) => ({ ...project, threadIds: threadIdsByProject.get(project.id) ?? [] }))
      .sort((left, right) => {
        const leftIndex = orderIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER;
        const rightIndex = orderIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER;
        return leftIndex - rightIndex || left.name.localeCompare(right.name, "zh-CN");
      });
    return {
      projects: projectList,
      recentThreadIds: selectRecentThreadIds(sidebarThreadIds, Object.keys(assignments ?? {})),
    };
  }

  private async projectsFromPage(page: Page): Promise<CodexProject[]> {
    return (await this.projectCatalogFromPage(page)).projects;
  }

  async openThread(threadId: string): Promise<{ threadId: string; openedAt: string }> {
    return this.runExclusive(async () => {
      const page = await this.mainPage();
      await this.ensureThread(page, threadId);
      return { threadId, openedAt: new Date().toISOString() };
    });
  }

  async listProjects(): Promise<CodexProjectCatalog> {
    return this.projectCatalogFromPage(await this.mainPage());
  }

  async createProject(name: string, rootPath: string): Promise<CodexProject & { duplicate: boolean }> {
    return this.runExclusive(async () => {
      const page = await this.mainPage();
      const projects = await this.projectsFromPage(page);
      const existing = projects.find((project) => project.rootPaths.some((candidate) => candidate.localeCompare(rootPath, undefined, { sensitivity: "accent" }) === 0));
      if (existing) return { ...existing, duplicate: true };
      if (projects.some((project) => project.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0)) {
        throw new Error("Project name already exists");
      }

      const id = crypto.randomUUID();
      const now = Date.now();
      const project: Omit<CodexProject, "threadIds"> & { createdAt: number; updatedAt: number } = { id, name, rootPaths: [rootPath], createdAt: now, updatedAt: now };
      const currentProjects = await this.getGlobalState<Record<string, CodexProject>>(page, "local-projects") ?? {};
      const currentOrder = await this.getGlobalState<string[]>(page, "project-order") ?? [];
      await this.setGlobalState(page, "local-projects", { ...currentProjects, [id]: project });
      await this.setGlobalState(page, "project-order", [id, ...currentOrder.filter((projectId) => projectId !== id)]);
      await this.setGlobalState(page, "selected-project", { type: "local", projectId: id });
      await page.getByRole("button", { name: `在 ${name} 中新建任务`, exact: true }).waitFor({ state: "visible", timeout: 8_000 }).catch(() => undefined);
      return { id, name, rootPaths: [rootPath], threadIds: [], duplicate: false };
    });
  }

  async createTask(projectId: string | null, content: string, clientMessageId: string, images: CodexImageInput[] = []): Promise<{ threadId: string; acceptedAt: string; duplicate: boolean }> {
    const existing = this.receipts.get(clientMessageId);
    if (existing) return { ...existing, duplicate: true };
    return this.runExclusive(async () => {
      const duplicate = this.receipts.get(clientMessageId);
      if (duplicate) return { ...duplicate, duplicate: true };
      const page = await this.mainPage();
      const previousThreadId = await this.currentThreadId(page);

      if (projectId) {
        const project = (await this.projectsFromPage(page)).find((candidate) => candidate.id === projectId);
        if (!project) throw new Error("Project not found");
        const button = page.getByRole("button", { name: `在 ${project.name} 中新建任务`, exact: true });
        if (await button.count() !== 1) throw new Error("Codex new task control is unavailable for this project");
        await button.click();
      } else {
        const button = page.locator("button:visible").filter({ hasText: /^新建任务$/ });
        if (await button.count() !== 1) throw new Error("Codex new task control is unavailable");
        await button.click();
      }

      if (previousThreadId) {
        await page.waitForFunction((id) => document.querySelector("[data-above-composer-conversation-id]")?.getAttribute("data-above-composer-conversation-id") !== id, previousThreadId, { timeout: 8_000 });
      }
      const editor = page.locator('[contenteditable="true"][role="textbox"]').first();
      await editor.waitFor({ state: "visible", timeout: 8_000 });
      await this.attachImages(page, images);
      await editor.fill(content);
      if (normalizeText(await editor.innerText()) !== normalizeText(content)) throw new Error("Composer content did not match the requested message");
      const action = page.locator(".composer-surface-chrome button.size-token-button-composer");
      if (await action.count() !== 1 || await action.isDisabled()) throw new Error("Codex send control is unavailable");
      const sentAt = Date.now();
      await action.click();

      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const threadId = await this.currentThreadId(page);
        if (threadId && threadId !== previousThreadId && await this.sessions.containsUserMessage(threadId, content, sentAt, images.length > 0)) {
          const receipt = { threadId, acceptedAt: new Date().toISOString(), confirmed: true };
          this.receipts.set(clientMessageId, receipt);
          return { ...receipt, duplicate: false };
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error("The new task was submitted, but its session was not detected within 20 seconds");
    });
  }

  private stopButton(page: Page) {
    return page.locator([
      'button:visible[aria-label*="stop" i]',
      'button:visible[title*="stop" i]',
      'button:visible[data-testid*="stop" i]',
      'button:visible[aria-label*="cancel generation" i]',
      'button:visible[aria-label*="停止"]',
      'button:visible[title*="停止"]',
      'button:visible[aria-label*="中止"]',
      'button:visible[title*="中止"]',
    ].join(", ")).first();
  }

  private imageFileInput(page: Page) {
    // Desktop has used both MIME-based and extension-based accept values, and
    // recent builds can leave more than one hidden input in the DOM.
    return page.locator([
      'input[type="file"][accept*="image" i]',
      'input[type="file"][accept*=".png" i]',
      'input[type="file"][accept*=".jpg" i]',
      'input[type="file"][accept*=".jpeg" i]',
      'input[type="file"][accept*=".webp" i]',
      'input[type="file"][accept*=".gif" i]',
      'input[type="file"][accept*=".avif" i]',
    ].join(", ")).last();
  }

  private async setImageFiles(page: Page, images: CodexImageInput[]): Promise<void> {
    const files = images.map((image) => ({ name: image.name, mimeType: image.mimeType, buffer: image.buffer }));
    let input = this.imageFileInput(page);
    if (await input.count() > 0) {
      await input.setInputFiles(files);
      return;
    }

    const trigger = page.locator([
      'button:visible[aria-label*="attach" i]',
      'button:visible[title*="attach" i]',
      'button:visible[aria-label*="添加" i]',
      'button:visible[title*="添加" i]',
      'button:visible[aria-label*="上传" i]',
      'button:visible[title*="上传" i]',
      'button:visible[data-testid*="attach" i]',
    ].join(", ")).last();
    if (await trigger.count() > 0) {
      const chooserPromise = page.waitForEvent("filechooser", { timeout: 2_000 }).catch(() => null);
      await trigger.click();
      const chooser = await chooserPromise;
      if (chooser) {
        await chooser.setFiles(files);
        return;
      }
    }

    input = this.imageFileInput(page);
    if (await input.count() === 0) {
      const addPhotos = page.getByRole("menuitem", { name: /添加照片|添加图片|添加文件|add photos?|add images?|attach files?/i })
        .or(page.getByRole("button", { name: /添加照片|添加图片|添加文件|add photos?|add images?|attach files?/i }))
        .last();
      if (await addPhotos.count() > 0) {
        const chooserPromise = page.waitForEvent("filechooser", { timeout: 2_000 }).catch(() => null);
        await addPhotos.click();
        const chooser = await chooserPromise;
        if (chooser) {
          await chooser.setFiles(files);
          return;
        }
        input = this.imageFileInput(page);
      }
    }
    if (await input.count() === 0) throw new Error("Codex image input is unavailable");
    await input.setInputFiles(files);
  }

  private async attachImages(page: Page, images: CodexImageInput[]): Promise<void> {
    if (!images.length) return;
    if (await this.pasteImages(page, images)) {
      await page.waitForTimeout(300);
      return;
    }
    await this.setImageFiles(page, images);
    await page.waitForTimeout(300);
  }

  private async pasteImages(page: Page, images: CodexImageInput[]): Promise<boolean> {
    const payload = images.map((image) => ({
      name: image.name,
      mimeType: image.mimeType,
      data: image.buffer.toString("base64"),
    }));
    return page.evaluate(async (entries) => {
      const editor = document.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"]');
      if (!editor) return false;
      const transfer = new DataTransfer();
      for (const entry of entries) {
        const binary = atob(entry.data);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        transfer.items.add(new File([bytes], entry.name, { type: entry.mimeType }));
      }
      const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer });
      editor.dispatchEvent(event);
      await new Promise((resolve) => setTimeout(resolve, 250));
      return event.defaultPrevented;
    }, payload);
  }

  private async submitComposerMessage(page: Page, content: string, images: CodexImageInput[], alternateFollowUpMode = false): Promise<void> {
    const editor = page.locator('[contenteditable="true"][role="textbox"]').first();
    if (await editor.count() !== 1) throw new Error("A unique Codex composer was not found");
    await this.attachImages(page, images);
    if (content) await editor.fill(content);
    if (normalizeText(await editor.innerText()) !== normalizeText(content)) {
      await editor.fill("");
      throw new Error("Composer content did not match the requested message");
    }
    if (alternateFollowUpMode) {
      // Desktop uses this shortcut to invert queue/steer for one running turn.
      await editor.press(process.platform === "darwin" ? "Meta+Shift+Enter" : "Control+Shift+Enter");
    } else {
      const action = this.composerSubmitButton(page).or(page.locator(".composer-surface-chrome button.size-token-button-composer")).first();
      if (await action.count() !== 1 || await action.isDisabled()) {
        await editor.fill("");
        throw new Error("Codex send control is unavailable");
      }
      await action.click();
    }
    await page.waitForFunction(() => (document.querySelector('[contenteditable="true"][role="textbox"]')?.textContent ?? "").trim() === "", undefined, { timeout: 5_000 });
  }

  private composerSubmitButton(page: Page) {
    return page.locator([
      'button:visible[aria-label*="send" i]',
      'button:visible[title*="send" i]',
      'button:visible[aria-label*="发送"]',
      'button:visible[title*="发送"]',
      'button:visible[aria-label*="引导"]',
      'button:visible[title*="引导"]',
      'button:visible[aria-label*="队列"]',
      'button:visible[title*="队列"]',
    ].join(", ")).last();
  }

  private async detectDesktopApproval(page: Page): Promise<ApprovalRequest | null> {
    const candidate = page.locator('button:visible').filter({ hasText: /^(allow|approve|continue|reject|deny|cancel)(\s|$)/i });
    if (await candidate.count() === 0) return null;
    const button = candidate.first();
    const label = ((await button.innerText().catch(() => "")) || (await button.getAttribute("aria-label")) || "需要审批").trim();
    const threadId = await this.currentThreadId(page);
    if (!threadId) return null;
    return { id: `desktop:${threadId}`, threadId, kind: "approval", title: label, detail: "Codex 桌面端正在等待审批", createdAt: null, source: "desktop" };
  }

  private async waitForThreadStatus(threadId: string, statuses: string[], timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const summary = (await this.sessions.listThreads()).find((thread) => thread.id === threadId);
      if (summary && statuses.includes(summary.status)) return;
      const runtime = await this.status();
      if (runtime.connected && !runtime.runningThreadIds.includes(threadId)) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async stopTask(threadId: string): Promise<{ threadId: string; acceptedAt: string }> {
    return this.runExclusive(async () => {
      const page = await this.mainPage();
      await this.ensureThread(page, threadId);
      const button = this.stopButton(page);
      if (await button.count() !== 1) throw new Error("Codex stop control is not visible for this task");
      await button.click();
      await this.waitForThreadStatus(threadId, ["interrupted", "completed", "error"]);
      return { threadId, acceptedAt: new Date().toISOString() };
    });
  }

  async decideApproval(threadId: string, decision: ApprovalDecision): Promise<{ threadId: string; decision: ApprovalDecision; acceptedAt: string }> {
    return this.runExclusive(async () => {
      const page = await this.mainPage();
      await this.ensureThread(page, threadId);
      const pattern = decision === "approve" ? /^(allow|approve|continue|yes)(\s|$)/i : /^(reject|deny|cancel|no)(\s|$)/i;
      const button = page.locator('button:visible').filter({ hasText: pattern }).first();
      if (await button.count() !== 1) throw new Error(`Codex ${decision === "approve" ? "approval" : "rejection"} control is not visible`);
      await button.click();
      await this.waitForThreadStatus(threadId, decision === "approve" ? ["running", "completed", "error"] : ["interrupted", "completed", "error"]);
      return { threadId, decision, acceptedAt: new Date().toISOString() };
    });
  }

  async sendMessage(threadId: string, content: string, clientMessageId: string, images: CodexImageInput[] = []): Promise<{ threadId: string; acceptedAt: string; confirmed: boolean; duplicate: boolean }> {
    const existing = this.receipts.get(clientMessageId);
    if (existing) return { ...existing, duplicate: true };
    return this.runExclusive(async () => {
      const duplicate = this.receipts.get(clientMessageId);
      if (duplicate) return { ...duplicate, duplicate: true };
      const summary = (await this.sessions.listThreads()).find((thread) => thread.id === threadId);
      if (!summary) throw new Error("Thread not found");
      const runtime = await this.status();
      if (runtime.runningThreadIds.includes(threadId)) {
        throw new Error("This task is already running; sending is blocked to avoid clicking its stop control");
      }
      const page = await this.mainPage();
      await this.ensureThread(page, threadId);
      await this.attachImages(page, images);
      const editor = page.locator('[contenteditable="true"][role="textbox"]').first();
      if (await editor.count() !== 1) throw new Error("A unique Codex composer was not found");
      if (content) await editor.fill(content);
      const actual = await editor.innerText();
      if (normalizeText(actual) !== normalizeText(content)) {
        await editor.fill("");
        throw new Error("Composer content did not match the requested message");
      }
      const action = this.composerSubmitButton(page).or(page.locator(".composer-surface-chrome button.size-token-button-composer")).first();
      if (await action.count() !== 1 || await action.isDisabled()) {
        await editor.fill("");
        throw new Error("Codex send control is unavailable");
      }
      const sentAt = Date.now();
      await action.click();
      await page.waitForFunction(() => (document.querySelector('[contenteditable="true"][role="textbox"]')?.textContent ?? "").trim() === "", undefined, { timeout: 5_000 });
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (await this.sessions.containsUserMessage(threadId, content, sentAt, images.length > 0)) {
          const receipt = { threadId, acceptedAt: new Date().toISOString(), confirmed: true };
          this.receipts.set(clientMessageId, receipt);
          return { ...receipt, duplicate: false };
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const receipt = { threadId, acceptedAt: new Date().toISOString(), confirmed: false };
      this.receipts.set(clientMessageId, receipt);
      return { ...receipt, duplicate: false };
    });
  }

  async sendFollowUpMessage(threadId: string, content: string, mode: FollowUpMode, clientMessageId: string, images: CodexImageInput[] = []): Promise<{ threadId: string; mode: FollowUpMode; acceptedAt: string; confirmed: boolean; duplicate: boolean }> {
    const existing = this.receipts.get(clientMessageId);
    if (existing) return { ...existing, mode, duplicate: true };
    return this.runExclusive(async () => {
      const duplicate = this.receipts.get(clientMessageId);
      if (duplicate) return { ...duplicate, mode, duplicate: true };
      const summary = (await this.sessions.listThreads()).find((thread) => thread.id === threadId);
      if (!summary) throw new Error("Thread not found");
      const page = await this.mainPage();
      await this.ensureThread(page, threadId);
      const runtime = await this.status();
      if (!runtime.runningThreadIds.includes(threadId)) throw new Error("This task is no longer running; send it as a regular message");

      // Use Desktop's visible composer and its one-shot queue/steer shortcut so
      // image attachments and the app's native follow-up behavior stay aligned.
      const sentAt = Date.now();
      if (mode === "interrupt") {
        const stop = this.stopButton(page);
        if (await stop.count() !== 1) throw new Error("Codex stop control is not visible for this task");
        await stop.click();
        await this.waitForThreadStatus(threadId, ["interrupted", "completed", "error"], 10_000);
        await this.submitComposerMessage(page, content, images);
      } else {
        const configuredMode = await this.getGlobalState<FollowUpMode>(page, "followUpQueueMode");
        await this.submitComposerMessage(page, content, images, shouldUseAlternateFollowUpShortcut(configuredMode, mode));
      }
      // Queue messages are not written to JSONL until the running turn ends.
      // The cleared Desktop composer is the acceptance signal; do one best-effort
      // receipt check without holding the mobile request open.
      const confirmed = await this.sessions.containsUserMessage(threadId, content, sentAt, images.length > 0);
      const receipt = { threadId, acceptedAt: new Date().toISOString(), confirmed };
      this.receipts.set(clientMessageId, receipt);
      return { ...receipt, mode, duplicate: false };
    });
  }
}
