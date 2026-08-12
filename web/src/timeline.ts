export interface RollbackItem {
  kind: string;
  role: string;
}

export interface TimelineActivityFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface TimelineDisplaySource extends RollbackItem {
  id: string;
  timestamp: string | null;
  phase?: string;
  activity?: {
    type: "command" | "file_change";
    fileCount?: number;
    additions?: number;
    deletions?: number;
    files?: TimelineActivityFile[];
  };
}

export type DesktopDisplayItem<T extends TimelineDisplaySource = TimelineDisplaySource> =
  | { type: "message" | "reasoning"; item: T; step?: number }
  | { type: "commands"; id: string; count: number }
  | { type: "processing"; id: string; commentary: T[]; reasoning: T | null; commandCount: number }
  | { type: "file_change"; id: string; fileCount: number; additions: number; deletions: number; files: TimelineActivityFile[] };

function relativeActivityPath(filePath: string, cwd: string | null): string {
  const normalizedFile = filePath.replace(/\\/g, "/");
  const normalizedRoot = (cwd ?? "").replace(/\\/g, "/").replace(/\/$/, "");
  return normalizedRoot && normalizedFile.toLocaleLowerCase().startsWith(`${normalizedRoot.toLocaleLowerCase()}/`)
    ? normalizedFile.slice(normalizedRoot.length + 1)
    : normalizedFile;
}

function fileChangeDisplay<T extends TimelineDisplaySource>(items: T[], cwd: string | null): DesktopDisplayItem<T> | null {
  if (!items.length) return null;
  const filesByPath = new Map<string, TimelineActivityFile>();
  for (const item of items) for (const file of item.activity?.files ?? []) {
    const filePath = relativeActivityPath(file.path, cwd);
    const existing = filesByPath.get(filePath);
    if (existing) {
      existing.additions += file.additions;
      existing.deletions += file.deletions;
    } else {
      filesByPath.set(filePath, { ...file, path: filePath });
    }
  }
  const files = [...filesByPath.values()];
  return {
    type: "file_change",
    id: `${items[0].id}:files`,
    fileCount: files.length || items.reduce((sum, item) => sum + (item.activity?.fileCount ?? 1), 0),
    additions: items.reduce((sum, item) => sum + (item.activity?.additions ?? 0), 0),
    deletions: items.reduce((sum, item) => sum + (item.activity?.deletions ?? 0), 0),
    files,
  };
}

function toolActivity<T extends TimelineDisplaySource>(items: T[]): { commands: T[]; fileChanges: T[] } {
  const tools: T[] = [];
  for (const item of items) {
    if (item.kind !== "tool_call") continue;
    if (item.activity?.type === "file_change" && tools.at(-1)?.activity?.type === "command") tools.pop();
    tools.push(item);
  }
  return {
    commands: tools.filter((item) => item.activity?.type !== "file_change"),
    fileChanges: tools.filter((item) => item.activity?.type === "file_change"),
  };
}

/** Builds the same completed-turn hierarchy used by Codex Desktop. */
export function buildDesktopTimeline<T extends TimelineDisplaySource>(items: T[], cwd: string | null): DesktopDisplayItem<T>[] {
  const result: DesktopDisplayItem<T>[] = [];
  let turnItems: T[] = [];
  let stepCount = 0;

  const flushTurn = () => {
    if (!turnItems.length) return;
    const finalMessages = turnItems.filter((item) => item.kind === "message" && item.role === "assistant" && item.phase === "final_answer");
    const legacyMessages = turnItems.filter((item) => item.kind === "message" && item.role === "assistant" && !item.phase);
    const completedMessages = finalMessages.length ? finalMessages : legacyMessages;
    const commentary = turnItems.filter((item) => item.kind === "message" && item.role === "assistant" && item.phase === "commentary");
    const reasoning = [...turnItems].reverse().find((item) => item.kind === "reasoning") ?? null;
    const { commands, fileChanges } = toolActivity(turnItems);
    const files = fileChangeDisplay(fileChanges, cwd);

    if (completedMessages.length) {
      if (commentary.length || reasoning || commands.length || fileChanges.length) {
        result.push({
          type: "processing",
          id: `${completedMessages[0].id}:processing`,
          commentary,
          reasoning: commentary.length ? null : reasoning,
          commandCount: commands.length,
        });
      }
      for (const item of completedMessages) result.push({ type: "message", item });
      if (files) result.push(files);
      turnItems = [];
      return;
    }

    // An active or interrupted turn has no final answer yet, so keep its live detail visible.
    let pendingReasoning: T | null = null;
    let pendingTools: T[] = [];
    const flushLiveTools = () => {
      if (!pendingTools.length) return;
      const live = toolActivity(pendingTools);
      if (live.commands.length) result.push({ type: "commands", id: `${live.commands[0].id}:commands`, count: live.commands.length });
      const liveFiles = fileChangeDisplay(live.fileChanges, cwd);
      if (liveFiles) result.push(liveFiles);
      pendingTools = [];
    };
    for (const item of turnItems) {
      if (item.kind === "reasoning") {
        pendingReasoning = item;
      } else if (item.kind === "tool_call") {
        pendingTools.push(item);
      } else if (item.kind === "message" && item.role === "assistant") {
        flushLiveTools();
        pendingReasoning = null;
        result.push({ type: "message", item });
      }
    }
    flushLiveTools();
    if (pendingReasoning) result.push({ type: "reasoning", item: pendingReasoning });
    turnItems = [];
  };

  for (const item of items) {
    if (item.kind === "message" && item.role === "user") {
      flushTurn();
      stepCount += 1;
      result.push({ type: "message", item, step: stepCount });
    } else {
      turnItems.push(item);
    }
  }
  flushTurn();
  return result;
}

export function rollbackTimelineItems<T extends RollbackItem>(items: T[], turns: number): T[] {
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

export function shouldShowThinking(items: RollbackItem[], running: boolean, hasLiveOutput: boolean): boolean {
  if (!running || hasLiveOutput) return false;
  let latestUserIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "message" && item.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 0) return false;
  return !items.slice(latestUserIndex + 1).some((item) =>
    (item.kind === "message" && item.role === "assistant")
    || item.kind === "reasoning"
    || item.kind === "tool_call",
  );
}
