import type { ThreadStatus, TimelineItem, TokenUsage } from "../types.js";

type JsonObject = Record<string, any>;

const INTERNAL_CONTEXT_PREFIXES = [
  "<environment_context>",
  "<app-context>",
  "<permissions instructions>",
  "<skills_instructions>",
];
const MAX_REASONING_TEXT_LENGTH = 4_000;

export function parseJsonLine(line: string): JsonObject | null {
  try {
    return JSON.parse(line) as JsonObject;
  } catch {
    return null;
  }
}

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const value = part as JsonObject;
      return typeof value.text === "string"
        ? value.text
        : typeof value.content === "string"
          ? value.content
          : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function extractUserText(content: unknown): string {
  const text = extractText(content);
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.trimStart().startsWith("# Files mentioned by the user:")) return text;

  const requestHeading = /^\s*## My request for Codex:\s*$/m.exec(normalized);
  if (!requestHeading) return text;
  return normalized
    .slice((requestHeading.index ?? 0) + requestHeading[0].length)
    .split("\n")
    .filter((line) => !/^\s*<\/?image(?:\s[^>]*)?>\s*$/i.test(line))
    .join("\n")
    .trim();
}

export function extractImages(content: unknown): Array<{ source: string; alt?: string }> {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part, index) => {
    if (!part || typeof part !== "object") return [];
    const value = part as JsonObject;
    const type = String(value.type ?? "").toLocaleLowerCase();
    if (!type.includes("image") && value.image_url == null && value.imageUrl == null) return [];
    const imageUrl = value.image_url ?? value.imageUrl;
    const source = typeof imageUrl === "string"
      ? imageUrl
      : typeof imageUrl?.url === "string"
        ? imageUrl.url
        : [value.path, value.file_path, value.local_path, value.url].find((candidate) => typeof candidate === "string");
    if (typeof source !== "string" || !source.trim()) return [];
    const alt = typeof value.alt === "string" ? value.alt : typeof value.name === "string" ? value.name : `图片 ${index + 1}`;
    return [{ source: source.trim(), alt }];
  });
}

function displayJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}

function countContentLines(value: unknown): number {
  if (typeof value !== "string" || !value) return 0;
  const normalized = value.replace(/\r\n/g, "\n");
  return normalized.split("\n").length - (normalized.endsWith("\n") ? 1 : 0);
}

function countUnifiedDiff(value: unknown): { additions: number; deletions: number } {
  if (typeof value !== "string") return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const line of value.split(/\r?\n/)) {
    if (/^\+(?!\+\+)/.test(line)) additions += 1;
    else if (/^-(?!--)/.test(line)) deletions += 1;
  }
  return { additions, deletions };
}

function patchActivity(payload: JsonObject): TimelineItem["activity"] | null {
  if (payload.success === false || !payload.changes || typeof payload.changes !== "object") return null;
  const files = Object.entries(payload.changes).flatMap(([sourcePath, rawChange]) => {
    if (!rawChange || typeof rawChange !== "object") return [];
    const change = rawChange as JsonObject;
    const type = String(change.type ?? "");
    let additions = 0;
    let deletions = 0;
    if (type === "add") additions = countContentLines(change.content);
    else if (type === "delete") deletions = countContentLines(change.content);
    else ({ additions, deletions } = countUnifiedDiff(change.unified_diff));
    const targetPath = typeof change.move_path === "string" && change.move_path ? change.move_path : sourcePath;
    return [{ path: targetPath, additions, deletions }];
  });
  if (!files.length) return null;
  return {
    type: "file_change",
    fileCount: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    files,
  };
}

export function statusFromEvent(eventType: string): ThreadStatus | undefined {
  if (["task_started", "turn_started"].includes(eventType)) return "running";
  if (["task_complete", "turn_completed"].includes(eventType)) return "completed";
  if (["turn_aborted", "task_aborted"].includes(eventType)) return "interrupted";
  if (eventType === "error") return "error";
  if (/approval|permission|authorization|consent/i.test(eventType) && /request|pending|needed|waiting/i.test(eventType)) return "waiting_approval";
  return undefined;
}

export function rollbackTurnsFromRecord(record: JsonObject): number {
  if (record.type !== "event_msg" || record.payload?.type !== "thread_rolled_back") return 0;
  const turns = Number(record.payload.num_turns);
  return Number.isSafeInteger(turns) && turns > 0 ? turns : 0;
}

export function rollbackTimelineItems(items: TimelineItem[], turns: number): TimelineItem[] {
  let keepLength = items.length;
  for (let turn = 0; turn < turns; turn += 1) {
    let turnStart = -1;
    for (let index = keepLength - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item?.kind === "message" && item.role === "user") {
        turnStart = index;
        break;
      }
    }
    if (turnStart < 0) return [];
    keepLength = turnStart;
  }
  return keepLength === items.length ? items : items.slice(0, keepLength);
}

export function timelineFromRecords(records: Array<{ record: JsonObject; offset: number }>, threadId: string): TimelineItem[] {
  let items: TimelineItem[] = [];
  for (const { record, offset } of records) {
    const rollbackTurns = rollbackTurnsFromRecord(record);
    if (rollbackTurns) {
      items = rollbackTimelineItems(items, rollbackTurns);
      continue;
    }
    const item = timelineFromRecord(record, threadId, offset);
    if (item && isVisibleTimelineItem(item)) items.push(item);
  }
  return items;
}

export function timelineFromRecord(record: JsonObject, threadId: string, offset: number): TimelineItem | null {
  const timestamp = typeof record.timestamp === "string" ? record.timestamp : null;
  const payload = record.payload ?? {};
  const id = `${threadId}:${offset}`;

  if (record.type === "response_item") {
    if (payload.type === "message") {
      const text = (payload.role === "user" ? extractUserText(payload.content) : extractText(payload.content)).trim();
      const images = extractImages(payload.content);
      if (!text && !images.length) return null;
      if (payload.role !== "user" && payload.role !== "assistant") return null;
      if (payload.role === "user" && INTERNAL_CONTEXT_PREFIXES.some((prefix) => text.startsWith(prefix))) return null;
      const role = payload.role;
      return { id, threadId, timestamp, kind: "message", role, text, images, phase: typeof payload.phase === "string" ? payload.phase : undefined };
    }
    if (["function_call", "custom_tool_call"].includes(payload.type)) {
      const name = payload.name ?? "tool";
      return { id, threadId, timestamp, kind: "tool_call", role: "assistant", text: String(name), activity: { type: "command" } };
    }
    if (["function_call_output", "custom_tool_call_output"].includes(payload.type)) {
      return { id, threadId, timestamp, kind: "tool_output", role: "tool", text: displayJson(payload.output ?? "") };
    }
    return null;
  }

  if (record.type === "event_msg") {
    const eventType = String(payload.type ?? "");
    if (eventType === "patch_apply_end") {
      const activity = patchActivity(payload);
      return activity ? { id, threadId, timestamp, kind: "tool_call", role: "assistant", text: "patch_apply_end", eventType, activity } : null;
    }
    const status = statusFromEvent(eventType);
    if (status) {
      return { id, threadId, timestamp, kind: "status", role: "system", text: status, eventType };
    }
    if (eventType === "agent_reasoning") {
      const rawText = String(payload.text ?? "").trim().replace(/^\*\*(.+)\*\*$/s, "$1");
      const text = rawText.length > MAX_REASONING_TEXT_LENGTH
        ? `${rawText.slice(0, MAX_REASONING_TEXT_LENGTH - 1).trimEnd()}…`
        : rawText;
      return text ? { id, threadId, timestamp, kind: "reasoning", role: "assistant", text, eventType } : null;
    }
  }
  return null;
}

export function isVisibleTimelineItem(item: TimelineItem): boolean {
  return item.kind === "message" || item.kind === "reasoning" || item.kind === "tool_call";
}

const URL_PATTERN = /https?:\/\/(?:[a-zA-Z0-9\-_.]+)(?:\/[^\s<>"'\]]*)?/gi;
const MAX_SOURCES = 20;

export function extractSources(records: Array<{ record: JsonObject; offset: number }>): string[] {
  const found = new Set<string>();
  for (const { record } of records) {
    if (record.type !== "response_item") continue;
    const payload = record.payload ?? {};
    if (payload.type !== "message" || payload.role !== "assistant") continue;
    const text = extractText(payload.content);
    if (!text) continue;
    const matches = text.matchAll(URL_PATTERN);
    for (const match of matches) {
      const url = match[0].replace(/[.,;:!?)]+$/, "");
      if (url.length > 10 && !found.has(url)) found.add(url);
      if (found.size >= MAX_SOURCES) break;
    }
    if (found.size >= MAX_SOURCES) break;
  }
  return [...found];
}

export function extractTokenUsage(records: Array<{ record: JsonObject; offset: number }>): TokenUsage | null {
  let latest: JsonObject | null = null;
  for (const { record } of records) {
    if (record.type !== "event_msg") continue;
    const payload = record.payload ?? {};
    if (payload.type !== "token_count") continue;
    latest = payload;
  }
  if (!latest) return null;
  const inputTokens = Number(latest.input_tokens ?? latest.inputTokens ?? 0) || 0;
  const outputTokens = Number(latest.output_tokens ?? latest.outputTokens ?? 0) || 0;
  const cacheTokens = Number(latest.cached_tokens ?? latest.cache_tokens ?? latest.cacheTokens ?? 0) || 0;
  const totalTokens = Number(latest.total_tokens ?? latest.totalTokens ?? (inputTokens + outputTokens + cacheTokens)) || 0;
  const cacheHitRate = totalTokens > 0 ? cacheTokens / totalTokens : 0;
  const cost = typeof latest.cost === "number" ? latest.cost : typeof latest.cost_usd === "number" ? latest.cost_usd : null;
  const model = typeof latest.model === "string" ? latest.model : typeof latest.model_name === "string" ? latest.model_name : null;
  return { inputTokens, outputTokens, cacheTokens, cacheHitRate, totalTokens, cost, model };
}

export function inferStatus(records: JsonObject[]): ThreadStatus {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (!record) continue;

    if (record.type === "event_msg") {
      const eventType = String(record.payload?.type ?? "");
      const status = statusFromEvent(eventType);
      if (status) return status;
      // Recent reasoning without a later terminal lifecycle event still means the task is active.
      if (eventType === "agent_reasoning") return "running";
      continue;
    }

    if (record.type === "response_item") {
      const payloadType = String(record.payload?.type ?? "");
      if (["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output", "reasoning"].includes(payloadType)) {
        return "running";
      }
    }
  }
  return "idle";
}
