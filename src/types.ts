export type ThreadStatus = "idle" | "running" | "waiting_approval" | "completed" | "interrupted" | "error";

export type ApprovalDecision = "approve" | "reject";

export interface ApprovalRequest {
  id: string;
  threadId: string;
  kind: "approval" | "permission";
  title: string;
  detail: string;
  createdAt: string | null;
  source: "session" | "desktop";
}

export interface ThreadSummary {
  id: string;
  title: string;
  cwd: string | null;
  filePath: string;
  archived: boolean;
  createdAt: string | null;
  updatedAt: string;
  status: ThreadStatus;
  preview: string;
}

export interface TimelineItem {
  id: string;
  threadId: string;
  timestamp: string | null;
  kind: "message" | "tool_call" | "tool_output" | "status" | "reasoning";
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  images?: Array<{ source: string; alt?: string }>;
  eventType?: string;
  phase?: string;
  activity?: {
    type: "command" | "file_change";
    fileCount?: number;
    additions?: number;
    deletions?: number;
    files?: Array<{ path: string; additions: number; deletions: number }>;
  };
}

export interface BridgeEvent {
  id: string;
  threadId: string;
  timestamp: string;
  item: TimelineItem | null;
  status?: ThreadStatus;
  rollbackTurns?: number;
}

export interface GitStatus {
  branch: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  ahead: number;
  behind: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  cacheHitRate: number;
  totalTokens: number;
  cost: number | null;
  model: string | null;
}

export interface EnvironmentInfo {
  git: GitStatus | null;
  tokenUsage: TokenUsage | null;
  sources: string[];
}
