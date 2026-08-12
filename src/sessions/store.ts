import { createReadStream } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { ApprovalRequest, EnvironmentInfo, ThreadSummary, TimelineItem } from "../types.js";
import { getGitStatus } from "../fs/git-status.js";
import { extractImages, extractSources, extractText, extractTokenUsage, extractUserText, inferStatus, parseJsonLine, timelineFromRecords } from "./parser.js";

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
type ParsedRecord = { record: Record<string, any>; offset: number };

async function walkJsonl(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(fullPath);
    }));
  }
  await walk(root);
  return result;
}

async function readRecords(filePath: string): Promise<ParsedRecord[]> {
  const records: ParsedRecord[] = [];
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let offset = 0;
  for await (const line of lines) {
    const record = parseJsonLine(line);
    if (record) records.push({ record, offset });
    offset += Buffer.byteLength(line, "utf8") + 1;
  }
  return records;
}

function approvalRequestsFromRecords(records: ParsedRecord[], threadId: string): ApprovalRequest[] {
  const pending: ApprovalRequest[] = [];
  for (const { record, offset } of records) {
    const payload = record.payload ?? {};
    const eventType = String(payload.type ?? record.type ?? "");
    if (!/approval|permission|authorization|consent/i.test(eventType)) continue;
    const serialized = JSON.stringify(payload);
    if (!/request|pending|needed|waiting/i.test(eventType) && !/pending|needs approval|permission required/i.test(serialized)) continue;
    const id = String(payload.id ?? payload.request_id ?? payload.call_id ?? `${threadId}:${offset}`);
    if (pending.some((item) => item.id === id)) continue;
    const detailValue = payload.detail ?? payload.reason ?? payload.command ?? payload.input;
    const detail = typeof detailValue === "string" ? detailValue : detailValue ? JSON.stringify(detailValue, null, 2) : "";
    pending.push({
      id,
      threadId,
      kind: /permission/i.test(eventType) ? "permission" : "approval",
      title: String(payload.title ?? payload.name ?? (payload.kind ? `${payload.kind} approval` : "需要审批")),
      detail,
      createdAt: typeof record.timestamp === "string" ? record.timestamp : null,
      source: "session",
    });
  }
  return pending.slice(-10);
}

async function readHeadTailRecords(filePath: string): Promise<Array<{ record: Record<string, any>; offset: number }>> {
  const fileStat = await stat(filePath);
  const windowSize = 64 * 1024;
  const handle = await open(filePath, "r");
  try {
    const headSize = Math.min(windowSize, fileStat.size);
    const headBuffer = Buffer.alloc(headSize);
    await handle.read(headBuffer, 0, headSize, 0);
    const tailStart = Math.max(0, fileStat.size - windowSize);
    const tailSize = fileStat.size - tailStart;
    const tailBuffer = Buffer.alloc(tailSize);
    await handle.read(tailBuffer, 0, tailSize, tailStart);
    const records: Array<{ record: Record<string, any>; offset: number }> = [];
    let offset = 0;
    for (const line of `${headBuffer.toString("utf8")}\n${tailBuffer.toString("utf8")}`.split(/\r?\n/)) {
      const record = parseJsonLine(line);
      if (record) records.push({ record, offset });
      offset += Buffer.byteLength(line, "utf8") + 1;
    }
    return records;
  } finally {
    await handle.close();
  }
}

export class SessionStore {
  private readonly sessionsRoot: string;
  private readonly archivedRoot: string;
  private readonly indexPath: string;
  private filesById = new Map<string, string>();
  private titlesById = new Map<string, string>();
  private envCache = new Map<string, { info: EnvironmentInfo | null; fileKey: string; expiresAt: number }>();

  constructor(private readonly codexHome: string) {
    this.sessionsRoot = path.join(codexHome, "sessions");
    this.archivedRoot = path.join(codexHome, "archived_sessions");
    this.indexPath = path.join(codexHome, "session_index.jsonl");
  }

  private async loadTitles(): Promise<Map<string, string>> {
    const titles = new Map<string, string>();
    try {
      const raw = await readFile(this.indexPath, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const row = parseJsonLine(line);
        if (row?.id && row?.thread_name) titles.set(String(row.id), String(row.thread_name));
      }
    } catch {}
    return titles;
  }

  async listThreads(): Promise<ThreadSummary[]> {
    const [active, archived, titles] = await Promise.all([
      walkJsonl(this.sessionsRoot),
      walkJsonl(this.archivedRoot),
      this.loadTitles(),
    ]);
    const summaries = await Promise.all([...active, ...archived].map(async (filePath) => {
      const fileStat = await stat(filePath);
      const records = await readHeadTailRecords(filePath);
      const meta = records.find(({ record }) => record.type === "session_meta")?.record.payload ?? {};
      const id = String(meta.id ?? path.basename(filePath).match(UUID_PATTERN)?.[0] ?? "");
      if (!id || meta.source?.subagent) return null;
      this.filesById.set(id, filePath);
      const messages = records
        .map(({ record }) => record.type === "response_item" && record.payload?.type === "message" ? record.payload : null)
        .filter(Boolean);
      const firstUser = messages.find((message) => message.role === "user");
      const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
      const titleCandidate = extractUserText(firstUser?.content).trim();
      const preview = extractText(lastAssistant?.content).trim();
      return {
        id,
        title: titles.get(id) ?? (titleCandidate.slice(0, 80) || path.basename(String(meta.cwd ?? id))),
        cwd: typeof meta.cwd === "string" ? meta.cwd : null,
        filePath,
        archived: filePath.startsWith(this.archivedRoot),
        createdAt: typeof meta.timestamp === "string" ? meta.timestamp : records[0]?.record.timestamp ?? null,
        updatedAt: fileStat.mtime.toISOString(),
        status: inferStatus(records.map(({ record }) => record)),
        preview: preview.slice(0, 180),
      } satisfies ThreadSummary;
    }));
    const threads = summaries.filter((value): value is ThreadSummary => value !== null).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const thread of threads) this.titlesById.set(thread.id, thread.title);
    return threads;
  }

  async getThreadTitle(threadId: string): Promise<string | null> {
    const cached = this.titlesById.get(threadId);
    if (cached) return cached;
    return (await this.listThreads()).find((thread) => thread.id === threadId)?.title ?? null;
  }

  async getThreadFile(threadId: string): Promise<string | null> {
    if (!UUID_PATTERN.test(threadId)) return null;
    if (!this.filesById.has(threadId)) await this.listThreads();
    return this.filesById.get(threadId) ?? null;
  }

  async getTimeline(threadId: string): Promise<TimelineItem[]> {
    const filePath = await this.getThreadFile(threadId);
    if (!filePath) return [];
    const records = await readRecords(filePath);
    return timelineFromRecords(records, threadId);
  }

  async getTimelineWithApprovals(threadId: string): Promise<{ items: TimelineItem[]; approvals: ApprovalRequest[] }> {
    const filePath = await this.getThreadFile(threadId);
    if (!filePath) return { items: [], approvals: [] };
    const records = await readRecords(filePath);
    return {
      items: timelineFromRecords(records, threadId),
      approvals: approvalRequestsFromRecords(records, threadId),
    };
  }

  async containsImageReference(threadId: string, source: string): Promise<boolean> {
    if (!source) return false;
    const timeline = await this.getTimeline(threadId);
    return timeline.some((item) => item.images?.some((image) => image.source === source));
  }

  async containsUserMessage(threadId: string, content: string, sinceMs: number, expectsImage = false): Promise<boolean> {
    const filePath = await this.getThreadFile(threadId);
    if (!filePath) return false;
    const records = await readRecords(filePath);
    return records.some(({ record }) => {
      if (record.type !== "response_item" || record.payload?.type !== "message" || record.payload?.role !== "user") return false;
      const timestamp = Date.parse(record.timestamp ?? "");
      if (timestamp < sinceMs - 2000) return false;
      const actualText = normalizeText(extractUserText(record.payload.content));
      const expectedText = normalizeText(content);
      const hasImage = extractImages(record.payload.content).length > 0;
      if (expectsImage) {
        // Desktop wraps pasted images with path/metadata text and can normalize
        // punctuation differently. The newly written image is the authoritative
        // receipt; text is only used as a best-effort additional check.
        return hasImage && (!expectedText || actualText.includes(expectedText) || expectedText.includes(actualText));
      }
      return actualText === expectedText;
    });
  }

  async getApprovalRequests(threadId: string): Promise<ApprovalRequest[]> {
    const filePath = await this.getThreadFile(threadId);
    if (!filePath) return [];
    const records = await readRecords(filePath);
    return approvalRequestsFromRecords(records, threadId);
  }

  async getEnvironmentInfo(threadId: string): Promise<EnvironmentInfo | null> {
    const filePath = await this.getThreadFile(threadId);
    if (!filePath) return null;
    const fileStat = await stat(filePath).catch(() => null);
    const fileKey = fileStat ? `${fileStat.mtimeMs}:${fileStat.size}` : "";
    const now = Date.now();
    const cached = this.envCache.get(threadId);
    if (cached && cached.fileKey === fileKey && cached.expiresAt > now) return cached.info;
    const records = await readRecords(filePath);
    const meta = records.find(({ record }) => record.type === "session_meta")?.record.payload ?? {};
    const cwd = typeof meta.cwd === "string" ? meta.cwd : null;
    const [git, tokenUsage, sources] = await Promise.all([
      getGitStatus(cwd),
      Promise.resolve(extractTokenUsage(records)),
      Promise.resolve(extractSources(records)),
    ]);
    const info: EnvironmentInfo = { git, tokenUsage, sources };
    this.envCache.set(threadId, { info, fileKey, expiresAt: Date.now() + 10_000 });
    return info;
  }
}

export function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\n{2,}/g, "\n").trim();
}
