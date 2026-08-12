import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, ArrowLeft, Ban, Blocks, Bot, CalendarClock, Check, CheckCircle2, ChevronDown, ChevronRight, ChevronUp, CircleAlert, Clock3, Folder, FolderPlus, FolderSearch, GitPullRequest, Hand, ImagePlus, Languages, LoaderCircle, Pin, PlugZap, Plus, RefreshCw, Search, Send, Settings, ShieldAlert, Square, SquarePen, Terminal, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { QRCodeSVG } from "qrcode.react";
import { createClientMessageId } from "./client-id";
import { buildDesktopTimeline, rollbackTimelineItems, shouldShowThinking, type DesktopDisplayItem, type TimelineActivityFile } from "./timeline";
import "./styles.css";

type Status = "idle" | "running" | "waiting_approval" | "completed" | "interrupted" | "error";
interface Thread { id: string; title: string; cwd: string | null; updatedAt: string; status: Status; preview: string }
interface Item { id: string; threadId: string; timestamp: string | null; kind: string; role: string; text: string; images?: Array<{ source: string; alt?: string }>; eventType?: string; phase?: string; activity?: { type: "command" | "file_change"; fileCount?: number; additions?: number; deletions?: number; files?: TimelineActivityFile[] } }
type DisplayItem = DesktopDisplayItem<Item>;
interface Approval { id: string; threadId: string; kind: string; title: string; detail: string; source: string }
interface Project { id: string; name: string; rootPaths: string[]; threadIds: string[] }
type PermissionMode = "ask" | "auto" | "full-access";
type DesktopMode = "codex" | "chatgpt-work";
type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
interface DesktopPermission { mode: PermissionMode | null; label: string | null; available: boolean }
interface DesktopState { connected?: boolean; editorReady?: boolean; currentThreadId?: string | null; runningThreadIds?: string[]; approval?: Approval | null; permissions?: DesktopPermission; mode?: DesktopMode | null; reasoningEffort?: ReasoningEffort | null; model?: string | null }
type FollowUpMode = "queue" | "steer" | "interrupt";
interface PendingImage { id: string; file: File; preview: string }
interface PairingInfo { available: boolean; expiresAt: number; pairingCode: string; urls: string[] }
interface GitStatus { branch: string | null; additions: number; deletions: number; changedFiles: number; ahead: number; behind: number }
interface TokenUsage { inputTokens: number; outputTokens: number; cacheTokens: number; cacheHitRate: number; totalTokens: number; cost: number | null; model: string | null }
interface EnvironmentInfo { git: GitStatus | null; tokenUsage: TokenUsage | null; sources: string[] }
const pinnedStorageKey = "mcodex.pinnedThreads";

const recentGroupId = "__recent__";
type Locale = "zh-CN" | "en-US";
const localeStorageKey = "mcodex.locale";
const savedLocale = localStorage.getItem(localeStorageKey) as Locale | null;
let activeLocale: Locale = savedLocale ?? (navigator.language.toLowerCase().startsWith("en") ? "en-US" : "zh-CN");

const translations: Record<string, string> = {
  "空闲": "Idle", "运行中": "Running", "等待审批": "Awaiting approval", "已完成": "Completed", "已中止": "Interrupted", "错误": "Error",
  "请求批准": "Ask for approval", "编辑外部文件和使用互联网时始终询问": "Always ask before editing external files or using the internet",
  "替我审批": "Approve for me", "仅对检测到的风险操作请求批准": "Ask for approval only for detected risky actions",
  "完全访问权限": "Full access", "可不受限制地访问互联网和您电脑上的任何文件": "Unrestricted access to the internet and every file on this computer",
  "引导当前任务": "Steer current task", "让 Codex 立即根据这条消息调整当前工作": "Ask Codex to adjust the current work immediately",
  "排队发送": "Queue message", "当前任务完成后，再自动发送这条消息": "Send this message automatically when the current task finishes",
  "停止并发送": "Stop and send", "先停止当前任务，然后发送这条消息": "Stop the current task, then send this message",
  "权限未知": "Unknown permission", "尚未连接，请先输入配对码": "Not connected. Enter the pairing code first",
  "你": "You", "系统": "System", "图片 {index}": "Image {index}",
  "已编辑 {path}": "Edited {path}", "已编辑 {count} 个文件": "Edited {count} files", "收起文件": "Collapse files", "再显示 {count} 个文件": "Show {count} more files",
  "已处理": "Processed", "运行了 {count} 个命令": "Ran {count} commands", "运行了多个命令": "Ran multiple commands", "运行了 1 个命令": "Ran 1 command",
  "仅支持 10 MB 以内的 AVIF、GIF、JPEG、PNG 或 WebP 图片": "Only AVIF, GIF, JPEG, PNG, or WebP images up to 10 MB are supported", "每条消息最多添加 4 张图片": "You can attach up to 4 images per message",
  "Codex": "Codex", "拉取请求": "Pull requests", "已安排": "Scheduled", "插件": "Plugins", "设置": "Settings", "项目": "Projects", "批准模式": "Approval mode", "切换模式": "Switch mode", "思考能力": "Thinking", "轻度": "Light", "中": "Medium", "高": "High", "极高": "X-High", "添加": "Add", "普通对话": "General chat", "完全访问": "Full access", "选择项目并输入第一条消息": "Choose a project and enter your first message", "Codex 远程控制": "Codex Remote Control", "本地任务工作台": "Local task workspace", "新建任务": "New task", "创建项目": "Create project", "刷新任务": "Refresh tasks",
  "正在连接": "Connecting", "实时连接": "Live connection", "连接断开": "Disconnected", "连接控制": "Control connection", "可控制": "Controllable", "只读": "Read-only", "搜索任务": "Search tasks",
  "折叠 {name}": "Collapse {name}", "展开 {name}": "Expand {name}", "在 {name} 中新建任务": "New task in {name}", "暂无摘要": "No summary", "暂无任务": "No tasks", "最近": "Recent", "展开或折叠最近任务": "Expand or collapse recent tasks", "新建普通对话": "New conversation", "没有找到相关任务": "No matching tasks",
  "返回任务列表": "Back to task list", "停止任务": "Stop task", "停止": "Stop", "批准": "Approve", "拒绝": "Reject", "正在加载对话": "Loading conversation", "正在思考": "Thinking", "更改 Desktop 权限": "Change Desktop permissions", "Desktop 权限暂不可用": "Desktop permissions unavailable", "添加图片": "Attach image", "移除 {name}": "Remove {name}", "正在连接当前任务的控制…": "Connecting to task controls…", "正在发送，请稍候…": "Sending, please wait…", "正在连接桌面控制…": "Connecting to Desktop controls…", "向当前任务发送消息": "Send a message to the current task", "桌面控制尚未连接，当前为只读模式": "Desktop controls are not connected; read-only mode", "正在发送": "Sending", "发送": "Send",
  "连接这台电脑": "Connect this computer", "选择一个任务": "Select a task", "正在验证并加载任务，请稍候…": "Verifying and loading tasks…", "手机与电脑连接同一 Wi-Fi 后，可扫码或输入配对码。": "Connect your phone and computer to the same Wi-Fi, then scan or enter the pairing code.", "任务进度会从本地会话文件实时同步。": "Task progress is synced from local session files.", "用手机扫码使用": "Scan with your phone", "打开手机相机扫描二维码，将自动连接这台电脑。": "Scan this QR code with your phone camera to connect automatically.", "配对码": "Pairing code", "手机扫码连接": "Connect by phone", "开始配对": "Pair", "正在配对": "Pairing",
  "请求超时，请检查连接后重试": "The request timed out. Check the connection and try again",
  "任务正在运行": "Task is running", "确认完全访问": "Confirm full access", "Desktop 权限": "Desktop permissions", "关闭": "Close", "这条消息将作为正在运行任务的后续指令发送：": "This message will be sent as a follow-up to the running task:", "已附加 {count} 张图片": "{count} images attached", "允许不受限制的访问？": "Allow unrestricted access?", "Codex 将无需批准即可访问互联网、运行命令，并读取、修改或删除这台电脑上的任意文件。": "Codex can access the internet, run commands, and read, modify, or delete any file on this computer without approval.", "返回": "Back", "正在同步": "Syncing", "开启完全访问": "Enable full access", "文件夹": "Folder", "不选择文件夹（普通对话）": "No folder (general conversation)", "第一条消息": "First message", "输入要交给 Codex 的任务": "Enter the task for Codex", "取消": "Cancel", "正在创建": "Creating", "创建并发送": "Create and send", "项目名称": "Project name", "留空则使用文件夹名称": "Leave blank to use the folder name", "项目文件夹路径": "Project folder path", "例如 C:\\Users\\你的用户名\\Desktop\\项目": "e.g. C:\\Users\\your-name\\Desktop\\project", "浏览远程电脑文件夹": "Browse folders on the remote computer", "浏览...": "Browse...", "正在添加": "Adding", "添加项目": "Add project",
  "选择文件夹": "Select folder", "快捷位置": "Quick locations", "加载中…": "Loading…", "返回上级": "Go to parent", "返回快捷位置": "Back to quick locations", "此目录没有子文件夹": "This folder has no subfolders", "选择此文件夹": "Select this folder", "没有可浏览的目录，请确认 Bridge 已重启到最新版本": "No folders available. Restart the Bridge and try again.",
  "配对码错误或已过期，请使用启动窗口中最新的配对码": "The pairing code is invalid or expired. Use the latest code from the launcher.", "配对尝试次数过多，请重新运行一键启动脚本": "Too many pairing attempts. Run the one-click launcher again.", "任务不存在或已被移除": "Task not found or already removed", "消息内容不能为空或过长": "Message is empty or too long", "请输入消息或添加图片": "Enter a message or attach an image", "图片无效；每条最多 4 张，每张不超过 10 MB": "Invalid images. Attach up to 4 images, each no larger than 10 MB", "未找到 Desktop 图片上传入口，请重启 Codex Desktop 后重试": "Desktop image upload is unavailable. Restart Codex Desktop and try again.", "消息标识无效，请重新发送": "Invalid message ID. Send it again.", "审批操作无效，请重试": "Invalid approval action. Try again.", "当前任务仍在运行，请等待完成或先停止任务": "The task is still running. Wait for it to finish or stop it first.", "后续消息处理方式无效，请重新选择": "Invalid follow-up mode. Choose again.", "当前任务已经结束，请直接发送消息": "The task has ended. Send a new message.", "后续消息已提交，但暂未读取到任务记录，请到桌面端检查": "Follow-up submitted, but the task record is not available yet. Check Desktop.", "暂时找不到停止按钮，请确认桌面端正在运行此任务": "The stop control is unavailable. Make sure Desktop is running this task.", "暂时找不到审批按钮，请确认桌面端正在等待审批": "The approval control is unavailable. Make sure Desktop is waiting for approval.", "无法操作桌面端输入框，请重新运行一键启动脚本": "Cannot control the Desktop composer. Run the one-click launcher again.", "目录路径无效": "Invalid directory path", "无法读取该目录，请换一个文件夹": "Cannot read this folder. Choose another one.", "桌面端发送按钮暂时不可用，请稍后重试": "Desktop send control is unavailable. Try again shortly.", "消息已提交，但暂未确认写入记录，请到桌面端检查": "Message submitted, but the receipt is not available yet. Check Desktop.", "无法连接 Codex 桌面端，请重新运行一键启动脚本": "Cannot connect to Codex Desktop. Run the one-click launcher again.", "桌面端响应超时，请确认 Codex 窗口运行正常后重试": "Desktop timed out. Make sure the Codex window is running, then try again.", "暂时找不到新建任务按钮，请确认 Codex 桌面端已经打开": "The new-task control is unavailable. Make sure Codex Desktop is open.", "新任务已提交，但暂未读取到任务记录，请到桌面端检查": "New task submitted, but the task record is not available yet. Check Desktop.", "所选项目不存在，请刷新项目列表": "Selected project not found. Refresh the project list.", "项目名称已经存在，请换一个名称": "That project name already exists. Choose another.", "请输入项目文件夹的完整路径": "Enter the full path to the project folder.", "项目文件夹不存在，请检查电脑上的路径": "Project folder not found. Check the path on the computer.", "项目名称无效，请重新输入": "Invalid project name. Enter another name.", "无法更新 Codex 桌面端，请重新运行一键启动脚本": "Cannot update Codex Desktop. Run the one-click launcher again.", "桌面端权限菜单暂时不可用，请确认当前任务编辑区已打开": "Desktop permission controls are unavailable. Open the task composer and try again.", "该权限已被 Desktop 策略禁用，无法从网页切换": "This permission is disabled by Desktop policy and cannot be changed here.", "权限请求已发送，但 Desktop 未确认变更，请回到桌面端检查": "Permission change sent, but Desktop did not confirm it. Check Desktop.", "无法连接本机服务，请确认一键启动窗口仍在运行": "Cannot connect to the local service. Make sure the launcher is still running.", "服务内部出错，请重新运行一键启动脚本": "Internal service error. Run the one-click launcher again.", "请求无效，请刷新页面后重试": "Invalid request. Refresh the page and try again.", "本机服务暂时出错，请稍后重试": "The local service is temporarily unavailable. Try again shortly.",
  "文件": "File", "编辑": "Edit", "视图": "View", "未知": "Unknown", "主菜单": "Main menu",
  "新对话": "New conversation", "环境信息": "Environment", "变更": "Changes", "分支": "Branch",
  "来源": "Sources", "查看全部": "View all", "收起": "Collapse",
  "非 Git 仓库": "Not a Git repo", "选择任务后显示环境信息": "Select a task to view environment",
  "进行中的目标": "Active goal", "本轮": "Turn", "输入": "Input", "输出": "Output",
  "会话": "Session", "缓存": "Cache", "费": "Cost", "置顶": "Pinned",
  "固定": "Pin", "取消固定": "Unpin"
};

function t(source: string, params: Record<string, string | number> = {}): string {
  const translated = activeLocale === "en-US" ? (translations[source] ?? source) : source;
  return translated.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? `{${key}}`));
}

function setLocale(locale: Locale): void {
  activeLocale = locale;
  localStorage.setItem(localeStorageKey, locale);
  document.documentElement.lang = locale;
}

function initialExpandedGroups(): Set<string> {
  try {
    const saved = JSON.parse(localStorage.getItem("expandedProjectIds") ?? "null");
    if (Array.isArray(saved)) return new Set(saved.filter((value): value is string => typeof value === "string"));
  } catch { /* Ignore invalid state from an older version. */ }
  return new Set([recentGroupId]);
}

function normalizedPath(value: string | null): string {
  return (value ?? "").replace(/[\\/]+$/, "").replace(/\\/g, "/").toLocaleLowerCase();
}

let bridgeToken = localStorage.getItem("bridgeToken") ?? "";
const headers = (): HeadersInit => bridgeToken ? { Authorization: `Bearer ${bridgeToken}` } : {};

function clearBridgeToken(): void {
  bridgeToken = "";
  localStorage.removeItem("bridgeToken");
  window.dispatchEvent(new Event("bridge-auth-required"));
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, { ...init, signal: init?.signal ?? controller.signal, headers: { ...headers(), "Content-Type": "application/json", ...(init?.headers ?? {}) } });
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) clearBridgeToken();
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    return body;
  } finally {
    window.clearTimeout(timeout);
  }
}

function imageSource(source: string, threadId: string): string {
  if (/^(?:data:|blob:|https?:)/i.test(source)) return source;
  if (source.startsWith("/api/media?")) return `${source}${bridgeToken ? `&token=${encodeURIComponent(bridgeToken)}` : ""}`;
  return `/api/media?threadId=${encodeURIComponent(threadId)}&path=${encodeURIComponent(source)}${bridgeToken ? `&token=${encodeURIComponent(bridgeToken)}` : ""}`;
}

async function imagePayload(image: PendingImage): Promise<{ name: string; mimeType: string; data: string }> {
  const bytes = new Uint8Array(await image.file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return { name: image.file.name, mimeType: image.file.type, data: btoa(binary) };
}

const statusLabel: Record<Status, string> = { idle: "空闲", running: "运行中", waiting_approval: "等待审批", completed: "已完成", interrupted: "已中止", error: "错误" };

const permissionModes: Array<{ mode: PermissionMode; title: string; description: string; icon: typeof Hand }> = [
  { mode: "ask", title: "请求批准", description: "编辑外部文件和使用互联网时始终询问", icon: Hand },
  { mode: "auto", title: "替我审批", description: "仅对检测到的风险操作请求批准", icon: Bot },
  { mode: "full-access", title: "完全访问权限", description: "可不受限制地访问互联网和您电脑上的任何文件", icon: ShieldAlert },
];

const followUpModes: Array<{ mode: FollowUpMode; title: string; description: string; icon: typeof Activity }> = [
  { mode: "steer", title: "引导当前任务", description: "让 Codex 立即根据这条消息调整当前工作", icon: Activity },
  { mode: "queue", title: "排队发送", description: "当前任务完成后，再自动发送这条消息", icon: Clock3 },
  { mode: "interrupt", title: "停止并发送", description: "先停止当前任务，然后发送这条消息", icon: Ban },
];

function permissionModeLabel(mode: PermissionMode | null, fallback: string | null = null): string {
  const title = permissionModes.find((option) => option.mode === mode)?.title;
  return title ? t(title).replace(activeLocale === "en-US" ? " access" : "权限", "") : fallback ? t(fallback) : t("权限未知");
}

function friendlyError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/unauthorized/i.test(message)) return t("尚未连接，请先输入配对码");
  if (/invalid or expired pairing code/i.test(message)) return t("配对码错误或已过期，请使用启动窗口中最新的配对码");
  if (/pairing temporarily locked/i.test(message)) return t("配对尝试次数过多，请重新运行一键启动脚本");
  if (/thread not found/i.test(message)) return t("任务不存在或已被移除");
  if (/content must contain/i.test(message)) return t("消息内容不能为空或过长");
  if (/message or image is required/i.test(message)) return t("请输入消息或添加图片");
  if (/images must be|image data is invalid|each image must be|images must use/i.test(message)) return t("图片无效；每条最多 4 张，每张不超过 10 MB");
  if (/image input is unavailable/i.test(message)) return t("未找到 Desktop 图片上传入口，请重启 Codex Desktop 后重试");
  if (/uuid clientmessageid/i.test(message)) return t("消息标识无效，请重新发送");
  if (/decision must be/i.test(message)) return t("审批操作无效，请重试");
  if (/already running/i.test(message)) return t("当前任务仍在运行，请等待完成或先停止任务");
  if (/follow-up mode must be/i.test(message)) return t("后续消息处理方式无效，请重新选择");
  if (/task is no longer running/i.test(message)) return t("当前任务已经结束，请直接发送消息");
  if (/accepted the follow-up/i.test(message)) return t("后续消息已提交，但暂未读取到任务记录，请到桌面端检查");
  if (/stop control is not visible/i.test(message)) return t("暂时找不到停止按钮，请确认桌面端正在运行此任务");
  if (/(approval|rejection) control is not visible/i.test(message)) return t("暂时找不到审批按钮，请确认桌面端正在等待审批");
  if (/composer was not found|composer content did not match/i.test(message)) return t("无法操作桌面端输入框，请重新运行一键启动脚本");
  if (/absolute directory path is required|directory path is required/i.test(message)) return t("目录路径无效");
  if (/enoent|eacces|eperm|无法读取目录/i.test(message)) return t("无法读取该目录，请换一个文件夹");
  if (/send control is unavailable/i.test(message)) return t("桌面端发送按钮暂时不可用，请稍后重试");
  if (/no matching jsonl receipt/i.test(message)) return t("消息已提交，但暂未确认写入记录，请到桌面端检查");
  if (/main page was not found|connectovercdp|cdp endpoint/i.test(message)) return t("无法连接 Codex 桌面端，请重新运行一键启动脚本");
  if (/timeout.*exceeded|desktop request timed out/i.test(message)) return t("桌面端响应超时，请确认 Codex 窗口运行正常后重试");
  if (/new task control is unavailable/i.test(message)) return t("暂时找不到新建任务按钮，请确认 Codex 桌面端已经打开");
  if (/new task was submitted/i.test(message)) return t("新任务已提交，但暂未读取到任务记录，请到桌面端检查");
  if (/project not found/i.test(message)) return t("所选项目不存在，请刷新项目列表");
  if (/project name already exists/i.test(message)) return t("项目名称已经存在，请换一个名称");
  if (/absolute project folder path/i.test(message)) return t("请输入项目文件夹的完整路径");
  if (/project folder does not exist/i.test(message)) return t("项目文件夹不存在，请检查电脑上的路径");
  if (/project name is invalid/i.test(message)) return t("项目名称无效，请重新输入");
  if (/desktop bridge is unavailable|failed to update codex desktop state/i.test(message)) return t("无法更新 Codex 桌面端，请重新运行一键启动脚本");
  if (/permission control is unavailable|permission options are unavailable|permission mode is unavailable/i.test(message)) return t("桌面端权限菜单暂时不可用，请确认当前任务编辑区已打开");
  if (/requested codex permission mode is disabled/i.test(message)) return t("该权限已被 Desktop 策略禁用，无法从网页切换");
  if (/permission mode did not change/i.test(message)) return t("权限请求已发送，但 Desktop 未确认变更，请回到桌面端检查");
  if (/failed to fetch|networkerror|load failed/i.test(message)) return t("无法连接本机服务，请确认一键启动窗口仍在运行");
  if (/aborterror|aborted|signal is aborted/i.test(message)) return t("请求超时，请检查连接后重试");
  if (/internal error/i.test(message)) return t("服务内部出错，请重新运行一键启动脚本");
  if (/^http 4\d\d$/i.test(message)) return t("请求无效，请刷新页面后重试");
  if (/^http 5\d\d$/i.test(message)) return t("本机服务暂时出错，请稍后重试");
  return activeLocale === "en-US" ? `Operation failed: ${message}` : `操作未完成：${message}`;
}

function eventLabel(item: Item): string {
  if (item.role === "user") return t("你");
  if (item.role === "assistant") return "Codex";
  return t("系统");
}

function MarkdownText({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>;
}

function MessageImages({ images, threadId }: { images: NonNullable<Item["images"]>; threadId: string }) {
  return <div className="message-images">{images.map((image, index) => {
    const source = imageSource(image.source, threadId);
    return <a key={`${image.source}:${index}`} href={source} target="_blank" rel="noreferrer"><img src={source} alt={image.alt ?? t("图片 {index}", { index: index + 1 })} loading="lazy" /></a>;
  })}</div>;
}

function FileChangeCard({ display }: { display: Extract<DisplayItem, { type: "file_change" }> }) {
  const [expanded, setExpanded] = useState(false);
  const collapsedCount = 3;
  const canCollapse = display.files.length > collapsedCount;
  const singleFile = display.files.length === 1 ? display.files[0] : null;
  const visibleFiles = singleFile ? [] : expanded ? display.files : display.files.slice(0, collapsedCount);
  const hiddenCount = display.files.length - visibleFiles.length;
  const listId = `file-list-${display.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

  return <section className="file-change-card">
    <header>
      <span className="file-change-icon"><SquarePen size={17} /></span>
      <div><strong title={singleFile?.path}>{singleFile ? t("已编辑 {path}", { path: singleFile.path }) : t("已编辑 {count} 个文件", { count: display.fileCount })}</strong><span className="file-change-total"><b>+{display.additions}</b><em>-{display.deletions}</em></span></div>
    </header>
    {visibleFiles.length > 0 && <div className="file-change-list" id={listId}>{visibleFiles.map((file) => <div key={file.path}><span title={file.path}>{file.path}</span><span className="file-change-diff">{file.additions > 0 && <b>+{file.additions}</b>}{file.deletions > 0 && <em>-{file.deletions}</em>}</span></div>)}</div>}
    {canCollapse && <button className="file-change-toggle" type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls={listId}>
      <span>{expanded ? t("收起文件") : t("再显示 {count} 个文件", { count: hiddenCount })}</span>{expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
    </button>}
  </section>;
}

function ProcessingSummary({ display }: { display: Extract<DisplayItem, { type: "processing" }> }) {
  const [expanded, setExpanded] = useState(false);
  const detailId = `processing-${display.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

  return <section className="processing-summary">
    <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls={detailId}>
      <span>{t("已处理")}</span>{expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
    </button>
    {expanded && <div className="processing-details" id={detailId}>
      {display.commentary.map((item) => <div className="processing-message markdown-body" key={item.id}><MarkdownText text={item.text} /></div>)}
      {!display.commentary.length && display.reasoning && <div className="processing-message" key={display.reasoning.id}>{display.reasoning.text}</div>}
      {display.commandCount > 0 && <div className="activity-row"><Terminal size={15} /><span>{display.commandCount > 1 ? t("运行了 {count} 个命令", { count: display.commandCount }) : t("运行了 1 个命令")}</span></div>}
    </div>}
  </section>;
}

function isActivelyRunning(thread: Thread, _desktopThreadId: string | null = null): boolean {
  return thread.status === "running";
}

function applyDesktopRuntime(threads: Thread[], status: DesktopState): Thread[] {
  if (!status.connected || !Array.isArray(status.runningThreadIds)) return threads;
  const running = new Set(status.runningThreadIds.filter((id) => typeof id === "string" && id && !id.startsWith("client-new-thread:")));
  return threads.map((thread) => {
    if (running.has(thread.id)) return thread.status === "running" ? thread : { ...thread, status: "running" };
    // Only demote session-running tasks that desktop no longer reports as active.
    return thread.status === "running" ? { ...thread, status: "interrupted" } : thread;
  });
}

function TopMenuBar({ cdpReady, topMenuOpen, onToggleMenu, onCloseMenu, onNewTask, onNewProject, onRefresh, onToggleLocale, locale }: { cdpReady: boolean | null; topMenuOpen: string | null; onToggleMenu: (id: string) => void; onCloseMenu: () => void; onNewTask: () => void; onNewProject: () => void; onRefresh: () => void; onToggleLocale: () => void; locale: Locale }) {
  const menus: Array<{ id: string; label: string; items: Array<{ label: string; action: () => void; disabled?: boolean } | "separator"> }> = [
    { id: "file", label: t("文件"), items: [
      { label: t("新建任务"), action: onNewTask, disabled: !cdpReady },
      { label: t("创建项目"), action: onNewProject, disabled: !cdpReady },
      "separator",
      { label: t("刷新任务"), action: onRefresh },
    ]},
    { id: "edit", label: t("编辑"), items: [
      { label: t("新对话"), action: onNewTask, disabled: !cdpReady },
    ]},
    { id: "view", label: t("视图"), items: [
      { label: locale === "zh-CN" ? "Switch to English" : "切换到中文", action: onToggleLocale },
    ]},
  ];
  return <nav className="top-menu" aria-label={t("主菜单")} onClick={(event) => event.stopPropagation()}>
    {menus.map((menu) => <div className="top-menu-item" key={menu.id}>
      <button className="top-menu-trigger" onClick={() => onToggleMenu(menu.id)} aria-expanded={topMenuOpen === menu.id}>{menu.label}</button>
      {topMenuOpen === menu.id && menu.items.length > 0 && <div className="top-menu-dropdown">
        {menu.items.map((item, index) => item === "separator" ? <hr key={`sep-${index}`} /> : <button key={item.label} onClick={() => { item.action(); onCloseMenu(); }} disabled={item.disabled}>{item.label}</button>)}
      </div>}
    </div>)}
  </nav>;
}

function EnvironmentPanel({ info, sourcesExpanded, onToggleSources, cwd }: { info: EnvironmentInfo | null; sourcesExpanded: boolean; onToggleSources: () => void; cwd: string | null }) {
  const git = info?.git ?? null;
  const tokens = info?.tokenUsage ?? null;
  const sources = info?.sources ?? [];
  const visibleSources = sourcesExpanded ? sources : sources.slice(0, 3);
  const hiddenCount = sources.length - visibleSources.length;
  return <aside className="env-panel">
    <header className="env-panel-header"><h2>{t("环境信息")}</h2></header>
    <div className="env-panel-body">
      {git ? <>
        <section className="env-section">
          <div className="env-section-title">{t("变更")}</div>
          <div className="env-row"><span className="env-delta-add">+{git.additions.toLocaleString()}</span><span className="env-delta-del">-{git.deletions.toLocaleString()}</span></div>
        </section>
        <section className="env-section">
          <div className="env-section-title">{t("分支")}</div>
          <div className="env-row"><span className="env-branch"><GitPullRequest size={13} />{git.branch}</span>{git.ahead > 0 && <span className="env-ahead-behind">↑{git.ahead}</span>}{git.behind > 0 && <span className="env-ahead-behind">↓{git.behind}</span>}</div>
        </section>
      </> : <div className="env-empty">{cwd ? t("非 Git 仓库") : t("选择任务后显示环境信息")}</div>}
      {sources.length > 0 && <section className="env-section">
        <div className="env-section-title">{t("来源")}</div>
        <div className="env-sources">
          {visibleSources.map((src) => <a key={src} className="env-source-link" href={src} target="_blank" rel="noreferrer"><ChevronRight size={14} /><span>{src.replace(/^https?:\/\//, "").replace(/\/$/, "")}</span></a>)}
          {hiddenCount > 0 && <button className="env-source-toggle" onClick={onToggleSources}>{sourcesExpanded ? t("收起") : t("查看全部")} ({sources.length})</button>}
        </div>
      </section>}
    </div>
  </aside>;
}

function formatTokenCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function StatusBar({ tokens, model, reasoningEffort, threadTitle, running }: { tokens: TokenUsage | null; model: string | null; reasoningEffort: ReasoningEffort | null; threadTitle: string; running: boolean }) {
  const effortLabel = reasoningEffort === "low" ? t("轻度") : reasoningEffort === "high" ? t("高") : reasoningEffort === "xhigh" ? t("极高") : reasoningEffort === "medium" ? t("中") : "";
  return <footer className="status-bar">
    {threadTitle && <span className="status-goal">{running ? `${t("进行中的目标")} ${threadTitle}` : threadTitle}</span>}
    {tokens && <span className="status-metrics">
      <span className="status-metric">{t("本轮")} {t("输入")} <b>{formatTokenCount(tokens.inputTokens)}</b> {t("输出")} <b>{formatTokenCount(tokens.outputTokens)}</b></span>
      <span className="status-metric">{t("会话")} <b>{formatTokenCount(tokens.totalTokens)}</b></span>
      {tokens.cacheTokens > 0 && <span className="status-metric">{t("缓存")} <b>{formatTokenCount(tokens.cacheTokens)}</b> ({Math.round(tokens.cacheHitRate * 100)}%)</span>}
      {tokens.cost != null && <span className="status-metric">{t("费")} <b>${tokens.cost.toFixed(2)}</b></span>}
    </span>}
    <span className="status-model-row">
      {(model || tokens?.model) && <span className="status-model">{model ?? tokens?.model}</span>}
      {effortLabel && <span className={`status-effort-badge${reasoningEffort === "xhigh" ? " xhigh" : ""}`}>{effortLabel}</span>}
    </span>
  </footer>;
}

function App() {
  const [locale, setLocaleState] = useState<Locale>(activeLocale);
  activeLocale = locale;
  useEffect(() => { setLocale(locale); }, [locale]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [recentThreadIds, setRecentThreadIds] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [followUpContent, setFollowUpContent] = useState("");
  const [streamingOutput, setStreamingOutput] = useState<{ threadId: string; text: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [cdpReady, setCdpReady] = useState<boolean | null>(null);
  const [desktopThreadId, setDesktopThreadId] = useState<string | null>(null);
  const [switchingThread, setSwitchingThread] = useState(false);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [error, setError] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [pairing, setPairing] = useState(false);
  const [needsPairing, setNeedsPairing] = useState(false);
  const [pairingInfo, setPairingInfo] = useState<PairingInfo | null>(null);
  const [authEpoch, setAuthEpoch] = useState(0);
  const [controlBusy, setControlBusy] = useState(false);
  const [desktopApproval, setDesktopApproval] = useState<Approval | null>(null);
  const [desktopPermissions, setDesktopPermissions] = useState<DesktopPermission>({ mode: null, label: null, available: false });
  const [desktopMode, setDesktopMode] = useState<DesktopMode | null>(null);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | null>(null);
  const [desktopModel, setDesktopModel] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"task" | "project" | "permissions" | "follow-up" | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [followUpSubmitting, setFollowUpSubmitting] = useState<FollowUpMode | null>(null);
  const [permissionConfirm, setPermissionConfirm] = useState(false);
  const [newTaskProjectId, setNewTaskProjectId] = useState("");
  const [newTaskContent, setNewTaskContent] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [folderBrowserOpen, setFolderBrowserOpen] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(initialExpandedGroups);
  const [envInfo, setEnvInfo] = useState<EnvironmentInfo | null>(null);
  const [pinnedThreadIds, setPinnedThreadIds] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(pinnedStorageKey) ?? "[]").filter((v: string) => typeof v === "string"); } catch { return []; } });
  const [topMenuOpen, setTopMenuOpen] = useState<string | null>(null);
  const [envSourcesExpanded, setEnvSourcesExpanded] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<string | null>(null);
  const openRequestRef = useRef(0);
  const lastAutoExpandedRef = useRef("");

  const selectedThread = threads.find((thread) => thread.id === selected) ?? null;
  const displayItems = useMemo<DisplayItem[]>(() => buildDesktopTimeline(items, selectedThread?.cwd ?? null), [items, selectedThread?.cwd]);
  const groupedThreads = useMemo(() => {
    const queryText = query.trim().toLocaleLowerCase();
    const claimed = new Set<string>();
    const assignedProjectByThread = new Map<string, string>();
    for (const project of projects) for (const threadId of project.threadIds ?? []) assignedProjectByThread.set(threadId, project.id);
    const groups = projects.map((project) => {
      const roots = project.rootPaths.map(normalizedPath);
      const projectMatches = `${project.name} ${project.rootPaths.join(" ")}`.toLocaleLowerCase().includes(queryText);
      const projectThreads = threads.filter((thread) => {
        const threadPath = normalizedPath(thread.cwd);
        const assignedProjectId = assignedProjectByThread.get(thread.id);
        const belongs = assignedProjectId ? assignedProjectId === project.id : Boolean(threadPath) && roots.some((root) => threadPath === root || threadPath.startsWith(`${root}/`));
        if (!belongs) return false;
        claimed.add(thread.id);
        return !queryText || projectMatches || `${thread.title} ${thread.preview} ${thread.cwd ?? ""}`.toLocaleLowerCase().includes(queryText);
      });
      return { project, threads: projectThreads, visible: !queryText || projectMatches || projectThreads.length > 0 };
    });
    const desktopRecent = new Set(recentThreadIds);
    const recent = threads.filter((thread) => {
      const matches = !queryText || `${thread.title} ${thread.preview} ${thread.cwd ?? ""}`.toLocaleLowerCase().includes(queryText);
      return matches && (queryText ? !claimed.has(thread.id) : desktopRecent.has(thread.id));
    });
    const pinned = threads.filter((thread) => pinnedThreadIds.includes(thread.id) && (!queryText || `${thread.title} ${thread.preview}`.toLocaleLowerCase().includes(queryText)));
    return { groups, recent, pinned };
  }, [threads, projects, recentThreadIds, query, pinnedThreadIds]);

  const projectForThread = useMemo(() => {
    const result = new Map<string, string>();
    for (const group of groupedThreads.groups) for (const thread of group.threads) result.set(thread.id, group.project.id);
    return result;
  }, [groupedThreads]);

  function toggleGroup(id: string) {
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function togglePin(threadId: string) {
    setPinnedThreadIds((current) => {
      const next = current.includes(threadId) ? current.filter((id) => id !== threadId) : [...current, threadId];
      localStorage.setItem(pinnedStorageKey, JSON.stringify(next));
      return next;
    });
  }
  useEffect(() => {
    const handler = (event: MouseEvent) => { if (topMenuOpen) setTopMenuOpen(null); };
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [topMenuOpen]);

  function openTaskDialog(projectId = "") {
    setNewTaskProjectId(projectId);
    setDialog("task");
  }

  function openFolderBrowser() {
    setFolderBrowserOpen(true);
  }

  function openPermissionsDialog() {
    setPermissionConfirm(false);
    setError("");
    setDialog("permissions");
  }

  async function refreshThreads() {
    try {
      const { threads: next, cdp } = await api<{ threads: Thread[]; cdp?: DesktopState }>("/api/threads");
      setThreads(applyDesktopRuntime(next, cdp ?? {}));
      setCdpReady(Boolean(cdp?.connected && cdp?.editorReady));
      setDesktopThreadId(cdp?.currentThreadId ?? null);
      setDesktopApproval(cdp?.approval ?? null);
      setDesktopPermissions(cdp?.permissions ?? { mode: null, label: null, available: false });
      setDesktopMode(cdp?.mode ?? null);
      setReasoningEffort(cdp?.reasoningEffort ?? null);
      setDesktopModel(cdp?.model ?? null);
      setNeedsPairing(false);
      setError("");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const unauthorized = /unauthorized/i.test(message);
      setNeedsPairing(unauthorized);
      setError(unauthorized ? "" : friendlyError(cause));
    }
  }

  async function refreshProjects(showError = false) {
    try {
      const result = await api<{ projects: Project[]; recentThreadIds?: string[] }>("/api/projects");
      setProjects(result.projects);
      setRecentThreadIds(result.recentThreadIds ?? []);
    } catch (cause) {
      if (showError) setError(friendlyError(cause));
    }
  }

  async function refreshPairingInfo() {
    try {
      const response = await fetch("/api/pairing-info");
      if (!response.ok) return;
      setPairingInfo(await response.json() as PairingInfo);
    } catch { /* The manual pairing form remains available. */ }
  }

  async function openThread(id: string, syncDesktop = true) {
    const requestId = ++openRequestRef.current;
    setSelected(id);
    setSwitchingThread(syncDesktop);
    setTimelineLoading(true);
    setItems([]);
    setApprovals([]);
    setEnvInfo(null);
    setError("");
    const timelineRequest = api<{ items: Item[]; approvals?: Approval[] }>(`/api/threads/${id}/timeline`);
    void api<EnvironmentInfo | null>(`/api/threads/${id}/environment`).then((info) => { if (requestId === openRequestRef.current) setEnvInfo(info); }).catch(() => {});
    void timelineRequest.then((timeline) => {
      if (requestId !== openRequestRef.current) return;
      setItems(timeline.items);
      setApprovals(timeline.approvals ?? []);
    }).catch((cause) => {
      if (requestId === openRequestRef.current) setError(friendlyError(cause));
    }).finally(() => {
      if (requestId === openRequestRef.current) setTimelineLoading(false);
    });

    if (!syncDesktop) {
      setSwitchingThread(false);
      return;
    }

    try {
      const desktop = await api<{ threadId: string }>(`/api/threads/${id}/open`, { method: "POST", body: "{}" });
      if (requestId === openRequestRef.current && desktop.threadId) setDesktopThreadId(desktop.threadId);
    } catch (cause) {
      if (requestId === openRequestRef.current) setError(friendlyError(cause));
    } finally {
      if (requestId === openRequestRef.current) setSwitchingThread(false);
    }
  }

  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => {
    const handleAuthRequired = () => {
      setNeedsPairing(true);
      setConnected(false);
      setCdpReady(false);
      setAuthEpoch((value) => value + 1);
    };
    window.addEventListener("bridge-auth-required", handleAuthRequired);
    return () => window.removeEventListener("bridge-auth-required", handleAuthRequired);
  }, []);
  useEffect(() => { localStorage.setItem("expandedProjectIds", JSON.stringify([...expandedProjects])); }, [expandedProjects]);
  useEffect(() => {
    if (!desktopThreadId) return;
    const projectId = projectForThread.get(desktopThreadId) ?? recentGroupId;
    const key = `${desktopThreadId}:${projectId}`;
    if (lastAutoExpandedRef.current === key) return;
    lastAutoExpandedRef.current = key;
    setExpandedProjects((current) => current.has(projectId) ? current : new Set([...current, projectId]));
  }, [desktopThreadId, projectForThread]);
  useEffect(() => { void refreshThreads(); void refreshProjects(); }, []);
  useEffect(() => {
    if (!needsPairing) return;
    void refreshPairingInfo();
    const timer = window.setInterval(() => void refreshPairingInfo(), 15_000);
    return () => window.clearInterval(timer);
  }, [needsPairing]);
  useEffect(() => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const websocketUrl = `${protocol}//${location.host}/ws${bridgeToken ? `?token=${encodeURIComponent(bridgeToken)}` : ""}`;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let reconnectAttempts = 0;
    let needsRecoverySync = false;
    let disposed = false;

    const syncMissedState = () => {
      void refreshThreads();
      void refreshProjects();
      const currentThreadId = selectedRef.current;
      if (currentThreadId) void openThread(currentThreadId, false);
    };

    const handleMessage = (message: MessageEvent) => {
      let data: any;
      try { data = JSON.parse(String(message.data)); } catch { return; }
      if (data.type === "desktop_state") {
        setThreads((current) => applyDesktopRuntime(current, data.status ?? {}));
        setCdpReady(Boolean(data.status?.connected && data.status?.editorReady));
        setDesktopThreadId(data.status?.currentThreadId ?? null);
        setDesktopApproval(data.status?.approval ?? null);
        setDesktopPermissions(data.status?.permissions ?? { mode: null, label: null, available: false });
        setDesktopMode(data.status?.mode ?? null);
        setReasoningEffort(data.status?.reasoningEffort ?? null);
        setDesktopModel(data.status?.model ?? null);
        return;
      }
      if (data.type === "stream_output") {
        setStreamingOutput(data.output ?? null);
        return;
      }
      if (data.type === "environment_info") {
        if (data.threadId === selectedRef.current) setEnvInfo(data.info ?? null);
        return;
      }
      if (data.type === "session_event") {
        const event = data.event;
        setThreads((current) => current.map((thread) => thread.id === event.threadId ? { ...thread, status: event.status ?? thread.status, updatedAt: event.timestamp } : thread));
        if (event.threadId === selectedRef.current) {
          if (event.rollbackTurns) setItems((current) => rollbackTimelineItems(current, event.rollbackTurns));
          if (event.item) {
            if (event.item.kind === "message" && event.item.role === "user") setStreamingOutput(null);
            setItems((current) => current.some((item) => item.id === event.item.id) ? current : [...current, event.item]);
          }
        }
      }
    };

    const connect = () => {
      if (disposed || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
      const nextSocket = new WebSocket(websocketUrl);
      socket = nextSocket;
      nextSocket.onopen = () => {
        if (disposed || socket !== nextSocket) return;
        setConnected(true);
        reconnectAttempts = 0;
        if (needsRecoverySync) {
          needsRecoverySync = false;
          syncMissedState();
        }
      };
      nextSocket.onmessage = handleMessage;
      nextSocket.onerror = () => nextSocket.close();
      nextSocket.onclose = () => {
        if (disposed || socket !== nextSocket) return;
        socket = null;
        setConnected(false);
        needsRecoverySync = true;
        const delay = Math.min(1_000 * (2 ** reconnectAttempts), 15_000);
        reconnectAttempts += 1;
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, delay);
      };
    };

    const reconnectNow = () => {
      if (disposed) return;
      if (socket?.readyState === WebSocket.OPEN) {
        syncMissedState();
        return;
      }
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      socket?.close();
      socket = null;
      connect();
    };
    const handleVisibilityChange = () => { if (document.visibilityState === "visible") reconnectNow(); };

    connect();
    window.addEventListener("online", reconnectNow);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      window.removeEventListener("online", reconnectNow);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      socket?.close();
    };
  }, [authEpoch]);
  useEffect(() => {
    if (selected && desktopThreadId && selected !== desktopThreadId && !switchingThread && !sending && !controlBusy && !dialogBusy) {
      void openThread(desktopThreadId, false);
    }
  }, [desktopThreadId]);
  useEffect(() => {
    const timeline = timelineRef.current;
    if (timeline) timeline.scrollTop = timeline.scrollHeight;
  }, [items, streamingOutput?.text]);

  function addImages(files: File[]) {
    const supported = new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"]);
    const valid = files.filter((file) => supported.has(file.type) && file.size > 0 && file.size <= 10 * 1024 * 1024);
    if (valid.length !== files.length) setError(t("仅支持 10 MB 以内的 AVIF、GIF、JPEG、PNG 或 WebP 图片"));
    if (!valid.length) return;
    setPendingImages((current) => {
      const available = Math.max(0, 4 - current.length);
      if (valid.length > available) setError(t("每条消息最多添加 4 张图片"));
      return [...current, ...valid.slice(0, available).map((file) => ({ id: createClientMessageId(), file, preview: URL.createObjectURL(file) }))];
    });
  }

  function removeImage(id: string) {
    setPendingImages((current) => {
      const target = current.find((image) => image.id === id);
      if (target) URL.revokeObjectURL(target.preview);
      return current.filter((image) => image.id !== id);
    });
  }

  function clearImages() {
    setPendingImages((current) => {
      for (const image of current) URL.revokeObjectURL(image.preview);
      return [];
    });
  }

  async function sendMessage() {
    if (!selected || (!draft.trim() && !pendingImages.length) || sending || switchingThread) return;
    const content = draft.trim();
    if (selectedThread?.status === "running") {
      setFollowUpContent(content);
      setError("");
      setDialog("follow-up");
      return;
    }
    setSending(true);
    setError("");
    try {
      await api(`/api/threads/${selected}/send`, { method: "POST", body: JSON.stringify({ content, images: await Promise.all(pendingImages.map(imagePayload)), clientMessageId: createClientMessageId() }) });
      setDraft("");
      clearImages();
    } catch (cause) { setError(friendlyError(cause)); }
    finally { setSending(false); }
  }

  async function submitFollowUp(mode: FollowUpMode) {
    if (!selected || (!followUpContent.trim() && !pendingImages.length) || dialogBusy) return;
    setDialogBusy(true);
    setFollowUpSubmitting(mode);
    setError("");
    try {
      await api(`/api/threads/${selected}/follow-up`, {
        method: "POST",
        body: JSON.stringify({ content: followUpContent, images: await Promise.all(pendingImages.map(imagePayload)), mode, clientMessageId: createClientMessageId() }),
      });
      setDraft("");
      setFollowUpContent("");
      clearImages();
      setDialog(null);
    } catch (cause) { setError(friendlyError(cause)); }
    finally { setDialogBusy(false); setFollowUpSubmitting(null); }
  }

  async function createTask(event: React.FormEvent) {
    event.preventDefault();
    if (!newTaskContent.trim() || dialogBusy) return;
    setDialogBusy(true);
    setError("");
    try {
      const result = await api<{ threadId: string }>("/api/tasks", {
        method: "POST",
        body: JSON.stringify({ projectId: newTaskProjectId || null, content: newTaskContent.trim(), clientMessageId: createClientMessageId() }),
      });
      setDialog(null);
      setNewTaskContent("");
      await refreshThreads();
      await openThread(result.threadId, false);
    } catch (cause) { setError(friendlyError(cause)); }
    finally { setDialogBusy(false); }
  }

  async function createProject(event: React.FormEvent) {
    event.preventDefault();
    if (!projectPath.trim() || dialogBusy) return;
    setDialogBusy(true);
    setError("");
    try {
      const project = await api<Project>("/api/projects", { method: "POST", body: JSON.stringify({ name: projectName.trim(), rootPath: projectPath.trim() }) });
      await refreshProjects(true);
      setNewTaskProjectId(project.id);
      setProjectName("");
      setProjectPath("");
      setDialog("task");
    } catch (cause) { setError(friendlyError(cause)); }
    finally { setDialogBusy(false); }
  }

  async function changeDesktopMode(mode: DesktopMode) {
    if (dialogBusy || desktopMode === mode) return;
    setDialogBusy(true);
    setError("");
    try {
      const result = await api<{ mode: DesktopMode | null }>("/api/mode", { method: "PUT", body: JSON.stringify({ mode }) });
      setDesktopMode(result.mode);
    } catch (cause) { setError(friendlyError(cause)); }
    finally { setDialogBusy(false); }
  }

  async function changeReasoningEffort(effort: ReasoningEffort) {
    if (dialogBusy || reasoningEffort === effort) return;
    setDialogBusy(true);
    setError("");
    try {
      const result = await api<{ effort: ReasoningEffort | null; label: string }>("/api/reasoning", { method: "PUT", body: JSON.stringify({ effort }) });
      setReasoningEffort(result.effort);
    } catch (cause) { setError(friendlyError(cause)); }
    finally { setDialogBusy(false); }
  }

  async function createTaskFromComposer() {
    if ((!draft.trim() && !pendingImages.length) || sending || !cdpReady) return;
    setSending(true);
    setError("");
    try {
      const result = await api<{ threadId: string }>("/api/tasks", {
        method: "POST",
        body: JSON.stringify({ projectId: newTaskProjectId || null, content: draft.trim(), images: await Promise.all(pendingImages.map(imagePayload)), clientMessageId: createClientMessageId() }),
      });
      setDraft("");
      clearImages();
      await refreshThreads();
      await openThread(result.threadId, false);
    } catch (cause) { setError(friendlyError(cause)); }
    finally { setSending(false); }
  }

  async function changePermissionMode(mode: PermissionMode) {
    if (dialogBusy || mode === desktopPermissions.mode) return;
    if (mode === "full-access" && !permissionConfirm) {
      setPermissionConfirm(true);
      return;
    }
    setDialogBusy(true);
    setError("");
    try {
      const permissions = await api<DesktopPermission>("/api/permissions", { method: "PUT", body: JSON.stringify({ mode }) });
      setDesktopPermissions(permissions);
      setPermissionConfirm(false);
      setDialog(null);
    } catch (cause) { setError(friendlyError(cause)); }
    finally { setDialogBusy(false); }
  }

  async function control(path: string, body?: object) {
    if (!selected || controlBusy) return;
    setControlBusy(true);
    setError("");
    try {
      await api(`/api/threads/${selected}/${path}`, { method: "POST", body: JSON.stringify(body ?? {}) });
      await refreshThreads();
      await openThread(selected);
    } catch (cause) { setError(friendlyError(cause)); }
    finally { setControlBusy(false); }
  }

  async function pairWithCode(rawCode: string) {
    const code = rawCode.trim();
    if (!code || pairing) return;
    setPairing(true);
    setError("");
    try {
      const result = await api<{ token: string }>("/api/pair", { method: "POST", body: JSON.stringify({ code }) });
      bridgeToken = result.token;
      localStorage.setItem("bridgeToken", bridgeToken);
      setPairingCode("");
      history.replaceState(null, "", location.pathname);
      setAuthEpoch((value) => value + 1);
      await refreshThreads();
      await refreshProjects();
    } catch (cause) { setError(friendlyError(cause)); }
    finally { setPairing(false); }
  }

  async function pairDevice(event: React.FormEvent) {
    event.preventDefault();
    await pairWithCode(pairingCode);
  }

  useEffect(() => {
    if (!needsPairing || pairing || bridgeToken) return;
    const code = new URLSearchParams(location.search).get("pairing") ?? pairingInfo?.pairingCode;
    if (code) void pairWithCode(code);
  }, [needsPairing, pairing, pairingInfo?.pairingCode]);

  const approvalVisible = Boolean(selected && (selectedThread?.status === "waiting_approval" || approvals.length > 0 || desktopApproval?.threadId === selected));
  const lastAssistantText = [...items].reverse().find((item) => item.kind === "message" && item.role === "assistant")?.text.trim() ?? "";
  const lastUserText = [...items].reverse().find((item) => item.kind === "message" && item.role === "user")?.text.trim() ?? "";
  const streamedText = streamingOutput?.text.trim() ?? "";
  const liveOutput = streamingOutput?.threadId === selected && streamedText !== lastAssistantText && streamedText !== lastUserText ? streamingOutput.text : "";
  const thinking = shouldShowThinking(items, Boolean(selectedThread && isActivelyRunning(selectedThread, desktopThreadId)), Boolean(liveOutput));
  const hasPendingMessage = Boolean(draft.trim() || pendingImages.length);
  const composerStopsTask = selectedThread?.status === "running" && !hasPendingMessage;

  return <main className={`app${selected ? " thread-open" : ""}${needsPairing ? " pairing-open" : ""}`}>
        <aside className="sidebar">
      <header className="brand"><div className="brand-mark"><Terminal size={19} /></div><div><strong>Codex</strong><span>mCodex</span></div><div className="brand-actions"><button className="icon-button" onClick={() => openTaskDialog()} title={t("新建任务")} disabled={!cdpReady}><SquarePen size={18} /></button><button className="icon-button" onClick={() => setDialog("project")} title={t("创建项目")} disabled={!cdpReady}><FolderPlus size={18} /></button><button className="icon-button" onClick={() => { void refreshThreads(); void refreshProjects(); }} title={t("刷新任务")}><RefreshCw size={18} /></button><button className="language-toggle" onClick={() => setLocaleState(locale === "zh-CN" ? "en-US" : "zh-CN")} title={locale === "zh-CN" ? "Switch to English" : "切换到中文"}><Languages size={17} /><span>{locale === "zh-CN" ? "EN" : "中"}</span></button></div></header>
      <div className="connection-row"><span className={`dot${connected === true ? " online" : connected === null ? " pending" : ""}`} />{connected === null ? t("正在连接") : connected ? t("实时连接") : t("连接断开")}<span className="divider" /><PlugZap size={14} />{cdpReady === null ? t("连接控制") : cdpReady ? t("可控制") : t("只读")}</div>
      <TopMenuBar cdpReady={cdpReady} topMenuOpen={topMenuOpen} onToggleMenu={(id) => setTopMenuOpen(topMenuOpen === id ? null : id)} onCloseMenu={() => setTopMenuOpen(null)} onNewTask={() => openTaskDialog()} onNewProject={() => setDialog("project")} onRefresh={() => { void refreshThreads(); void refreshProjects(); }} onToggleLocale={() => setLocaleState(locale === "zh-CN" ? "en-US" : "zh-CN")} locale={locale} />
      <nav className="desktop-nav" aria-label={t("主菜单")}>
        <button className="sidebar-item nav-item" onClick={() => openTaskDialog(newTaskProjectId)} disabled={!cdpReady} title={t("新对话")}><SquarePen size={16} /><span>{t("新对话")}</span></button>
        <button className="sidebar-item nav-item" onClick={() => setQuery("拉取请求")} title={t("拉取请求")}><GitPullRequest size={16} /><span>{t("拉取请求")}</span></button>
        <button className="sidebar-item nav-item" onClick={() => setQuery("已安排")} title={t("已安排")}><CalendarClock size={16} /><span>{t("已安排")}</span></button>
        <button className="sidebar-item nav-item" onClick={() => setQuery("插件")} title={t("插件")}><Blocks size={16} /><span>{t("插件")}</span></button>
      </nav>
      <label className="search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("搜索任务")} /></label>
      <div className="thread-list">
        {groupedThreads.pinned.length > 0 && <section className="project-group pinned-group">
          <div className="sidebar-caption"><Pin size={13} style={{ verticalAlign: "-1px", marginRight: 5 }} />{t("置顶")}</div>
          {groupedThreads.pinned.map((thread) => <button key={thread.id} className={`thread-row ${selected === thread.id ? "selected" : ""}`} onClick={() => void openThread(thread.id)} aria-current={desktopThreadId === thread.id ? "page" : undefined}>
            <span className="thread-state">{isActivelyRunning(thread, desktopThreadId) ? <LoaderCircle className="spin running-spinner" size={14} /> : <span className={`status-pip ${thread.status}`} />}</span>
            <span className="thread-copy"><strong>{thread.title}</strong><span>{thread.preview || t("暂无摘要")}</span></span>
            <time>{new Date(thread.updatedAt).toLocaleTimeString(activeLocale, { hour: "2-digit", minute: "2-digit" })}</time>
            <span className="thread-pin pinned" role="button" tabIndex={0} title={t("取消固定")} onClick={(e) => { e.stopPropagation(); togglePin(thread.id); }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); togglePin(thread.id); } }}><Pin size={13} /></span>
          </button>)}
        </section>}
        <div className="sidebar-caption">{t("项目")}</div>
        {groupedThreads.groups.filter((group) => group.visible).map(({ project, threads: projectThreads }) => {
          const expanded = expandedProjects.has(project.id) || Boolean(query.trim());
          const containsCurrent = projectThreads.some((thread) => thread.id === desktopThreadId);
          const projectRunning = projectThreads.some((thread) => isActivelyRunning(thread, desktopThreadId));
          return <section className="project-group" key={project.id}>
            <div className={`project-row${containsCurrent ? " active" : ""}`}>
              <button className="project-toggle" onClick={() => toggleGroup(project.id)} aria-expanded={expanded} title={expanded ? t("折叠 {name}", { name: project.name }) : t("展开 {name}", { name: project.name })}>
                <ChevronRight className="project-chevron" size={16} />{projectRunning ? <LoaderCircle className="spin project-running" size={17} /> : <Folder size={17} />}<span>{project.name}</span><small>{projectThreads.length}</small>
              </button>
              <button className="project-new-task" onClick={() => openTaskDialog(project.id)} title={t("在 {name} 中新建任务", { name: project.name })} disabled={!cdpReady}><Plus size={16} /></button>
            </div>
            {expanded && <div className="project-threads">{projectThreads.length ? projectThreads.map((thread) => <button key={thread.id} className={`thread-row nested ${selected === thread.id ? "selected" : ""}`} onClick={() => void openThread(thread.id)} aria-current={desktopThreadId === thread.id ? "page" : undefined}>
              <span className="thread-state">{isActivelyRunning(thread, desktopThreadId) ? <LoaderCircle className="spin running-spinner" size={14} /> : <span className={`status-pip ${thread.status}`} />}</span>
              <span className="thread-copy"><strong>{thread.title}</strong><span>{thread.preview || t("暂无摘要")}</span></span>
              <time>{new Date(thread.updatedAt).toLocaleTimeString(activeLocale, { hour: "2-digit", minute: "2-digit" })}</time>
              <span className={`thread-pin${pinnedThreadIds.includes(thread.id) ? " pinned" : ""}`} role="button" tabIndex={0} title={pinnedThreadIds.includes(thread.id) ? t("取消固定") : t("固定")} onClick={(e) => { e.stopPropagation(); togglePin(thread.id); }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); togglePin(thread.id); } }}><Pin size={13} /></span>
            </button>) : <p className="group-empty">{t("暂无任务")}</p>}</div>}
          </section>;
        })}
        {(groupedThreads.recent.length > 0 || !query.trim()) && <section className="project-group recent-group">
          <div className="project-row">
            <button className="project-toggle" onClick={() => toggleGroup(recentGroupId)} aria-expanded={expandedProjects.has(recentGroupId) || Boolean(query.trim())} title={t("展开或折叠最近任务")}>
              <ChevronRight className="project-chevron" size={16} />{groupedThreads.recent.some((thread) => isActivelyRunning(thread, desktopThreadId)) ? <LoaderCircle className="spin project-running" size={17} /> : <Clock3 size={17} />}<span>{t("最近")}</span><small>{groupedThreads.recent.length}</small>
            </button>
            <button className="project-new-task" onClick={() => openTaskDialog()} title={t("新建普通对话")} disabled={!cdpReady}><Plus size={16} /></button>
          </div>
          {(expandedProjects.has(recentGroupId) || Boolean(query.trim())) && <div className="project-threads">{groupedThreads.recent.map((thread) => <button key={thread.id} className={`thread-row nested ${selected === thread.id ? "selected" : ""}`} onClick={() => void openThread(thread.id)} aria-current={desktopThreadId === thread.id ? "page" : undefined}>
            <span className="thread-state">{isActivelyRunning(thread, desktopThreadId) ? <LoaderCircle className="spin running-spinner" size={14} /> : <span className={`status-pip ${thread.status}`} />}</span>
            <span className="thread-copy"><strong>{thread.title}</strong><span>{thread.preview || thread.cwd || t("暂无摘要")}</span></span>
            <time>{new Date(thread.updatedAt).toLocaleTimeString(activeLocale, { hour: "2-digit", minute: "2-digit" })}</time>
            <span className={`thread-pin${pinnedThreadIds.includes(thread.id) ? " pinned" : ""}`} role="button" tabIndex={0} title={pinnedThreadIds.includes(thread.id) ? t("取消固定") : t("固定")} onClick={(e) => { e.stopPropagation(); togglePin(thread.id); }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); togglePin(thread.id); } }}><Pin size={13} /></span>
          </button>)}</div>}
        </section>}
        {query.trim() && groupedThreads.groups.every((group) => !group.visible) && groupedThreads.recent.length === 0 && <p className="sidebar-empty">{t("没有找到相关任务")}</p>}
      </div>
      <footer className="sidebar-footer">
        <button className="sidebar-item" onClick={() => setDialog("project")} disabled={!cdpReady} title={t("创建项目")}><FolderPlus size={16} /><span>{t("项目")}</span></button>
        <button className="sidebar-item" onClick={() => setLocaleState(locale === "zh-CN" ? "en-US" : "zh-CN")} title={t("设置")}><Settings size={16} /><span>{t("设置")}</span></button>
      </footer>
    </aside>
    <section className="workspace">
      {selectedThread ? <>
        <header className="thread-header"><button className="icon-button mobile-back" onClick={() => setSelected(null)} title={t("返回任务列表")}><ArrowLeft size={20} /></button><div><h1>{selectedThread.title}</h1><p>{selectedThread.cwd}</p></div><span className={`status-chip ${selectedThread.status}`}>{selectedThread.status === "running" ? <Activity size={14} /> : selectedThread.status === "waiting_approval" ? <CircleAlert size={14} /> : <CheckCircle2 size={14} />}{t(statusLabel[selectedThread.status])}</span>{approvalVisible && <div className="thread-actions"><button className="control-button approve" onClick={() => void control("approval", { decision: "approve" })} disabled={controlBusy || switchingThread} title={t("批准")}><Check size={16} />{t("批准")}</button><button className="control-button reject" onClick={() => void control("approval", { decision: "reject" })} disabled={controlBusy || switchingThread} title={t("拒绝")}><X size={16} />{t("拒绝")}</button></div>}</header>
        <div className="timeline" ref={timelineRef}>
          {timelineLoading && <div className="timeline-loading" role="status"><LoaderCircle className="spin" size={18} />{t("正在加载对话")}</div>}
          {displayItems.map((display) => {
            if (display.type === "reasoning") return <div key={display.item.id} className={`progress-event${isActivelyRunning(selectedThread, desktopThreadId) ? " active" : ""}`}>{display.item.text}</div>;
            if (display.type === "processing") return <ProcessingSummary key={display.id} display={display} />;
            if (display.type === "commands") return <div key={display.id} className="activity-row"><Terminal size={15} /><span>{display.count > 1 ? t("运行了多个命令") : t("运行了 1 个命令")}</span></div>;
            if (display.type === "file_change") return <FileChangeCard key={display.id} display={display} />;
            const item = display.item;
            if (item.role === "assistant") return <article key={item.id} className="assistant-message markdown-body">{item.images?.length ? <MessageImages images={item.images} threadId={item.threadId} /> : null}{item.text && <MarkdownText text={item.text} />}</article>;
            if (item.role === "user") return <React.Fragment key={item.id}>
              {display.step != null && <div className="step-indicator"><span className="step-dot" />Step {display.step}</div>}
              <article className="event user">
              <div className="event-body">{item.timestamp && <div className="event-meta"><time>{new Date(item.timestamp).toLocaleTimeString(activeLocale)}</time></div>}<div className="user-bubble">{item.images?.length ? <MessageImages images={item.images} threadId={item.threadId} /> : null}{item.text && <div className="message-text markdown-body"><MarkdownText text={item.text} /></div>}</div></div>
            </article></React.Fragment>;
            return <article key={item.id} className={`event ${item.role}`}>
              <div className="event-icon"><Clock3 size={16} /></div>
              <div className="event-body"><div className="event-meta"><span>{eventLabel(item)}</span>{item.timestamp && <time>{new Date(item.timestamp).toLocaleTimeString(activeLocale)}</time>}</div>{item.images?.length ? <MessageImages images={item.images} threadId={item.threadId} /> : null}{item.text && <div className="message-text markdown-body"><MarkdownText text={item.text} /></div>}</div>
            </article>;
          })}
          {thinking && <div className="progress-event active" role="status" aria-live="polite">{t("正在思考")}</div>}
          {liveOutput && <article className="assistant-message markdown-body streaming-message"><MarkdownText text={liveOutput} /><span className="stream-caret" aria-hidden="true" /></article>}
        </div>
        {error && <div className="error-bar"><CircleAlert size={16} />{error}</div>}
        <StatusBar tokens={envInfo?.tokenUsage ?? null} model={desktopModel} reasoningEffort={reasoningEffort} threadTitle={selectedThread.title} running={isActivelyRunning(selectedThread, desktopThreadId)} />
        <footer className="composer">
                  <div className="composer-toolbar">
          <select className="composer-control composer-project" value={newTaskProjectId || (selected ? projectForThread.get(selected) ?? "" : "")} onChange={(event) => setNewTaskProjectId(event.target.value)} aria-label={t("项目")} disabled={dialogBusy}>
            <option value="">{t("普通对话")}</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <select className="composer-control" value={desktopPermissions.mode ?? ""} onChange={(event) => void changePermissionMode(event.target.value as PermissionMode)} aria-label={t("批准模式")} disabled={!desktopPermissions.available || dialogBusy}>
            <option value="">{t("权限未知")}</option>
            <option value="ask">{t("请求批准")}</option>
            <option value="auto">{t("替我审批")}</option>
            <option value="full-access">{t("完全访问")}</option>
          </select>
          <select className="composer-control" value={desktopMode ?? ""} onChange={(event) => void changeDesktopMode(event.target.value as DesktopMode)} aria-label={t("切换模式")} disabled={!cdpReady || desktopMode === null || dialogBusy}>
            <option value="" disabled>{t("未知")}</option>
            <option value="codex">Codex</option>
            <option value="chatgpt-work">ChatGPT Work</option>
          </select>
          <select className="composer-control" value={reasoningEffort ?? ""} onChange={(event) => void changeReasoningEffort(event.target.value as ReasoningEffort)} aria-label={t("思考能力")} disabled={!cdpReady || reasoningEffort === null || dialogBusy}>
            <option value="" disabled>{t("未知")}</option>
            <option value="low">{t("轻度")}</option>
            <option value="medium">{t("中")}</option>
            <option value="high">{t("高")}</option>
            <option value="xhigh">{t("极高")}</option>
          </select>
          <button className="attach-button" type="button" onClick={() => imageInputRef.current?.click()} disabled={!cdpReady || sending || switchingThread || pendingImages.length >= 4} title={t("添加图片")}><ImagePlus size={16} /><span>{t("添加")}</span></button>
          <input ref={imageInputRef} className="image-file-input" type="file" accept="image/avif,image/gif,image/jpeg,image/png,image/webp" multiple onChange={(event) => { addImages(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
        </div>
          {pendingImages.length > 0 && <div className="pending-images">{pendingImages.map((image) => <div className="pending-image" key={image.id}><img src={image.preview} alt={image.file.name} /><button type="button" onClick={() => removeImage(image.id)} title={t("移除 {name}", { name: image.file.name })} disabled={sending}><X size={14} /></button></div>)}</div>}
          <div className="composer-input-row"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onPaste={(event) => { const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/")); if (images.length) { event.preventDefault(); addImages(images); } }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder={switchingThread ? t("正在连接当前任务的控制…") : sending ? t("正在发送，请稍候…") : cdpReady === null ? t("正在连接桌面控制…") : cdpReady ? t("向当前任务发送消息") : t("桌面控制尚未连接，当前为只读模式")} disabled={!cdpReady || sending || switchingThread} /><button className={`send-button${composerStopsTask ? " stop" : ""}`} onClick={() => composerStopsTask ? void control("stop") : void sendMessage()} disabled={!cdpReady || sending || switchingThread || controlBusy || (!composerStopsTask && !hasPendingMessage)} title={composerStopsTask ? t("停止任务") : sending ? t("正在发送") : t("发送")} aria-label={composerStopsTask ? t("停止任务") : t("发送")}>{composerStopsTask ? <Square size={13} fill="currentColor" strokeWidth={0} /> : sending ? <LoaderCircle className="spin" size={19} /> : <Send size={19} />}</button></div>
        </footer>
      </> : <div className={`empty${needsPairing ? " pairing-empty" : ""}`}><div className="empty-mark"><Terminal size={28} /></div><h1>{needsPairing ? t("连接这台电脑") : t("新建任务")}</h1><p>{needsPairing ? pairing ? t("正在验证并加载任务，请稍候…") : t("手机与电脑连接同一 Wi-Fi 后，可扫码或输入配对码。") : t("选择项目并输入第一条消息。")}</p>{!needsPairing && <div className="empty-composer">
          <select className="composer-control composer-project" value={newTaskProjectId} onChange={(event) => setNewTaskProjectId(event.target.value)} aria-label={t("项目")} disabled={dialogBusy || sending}>
            <option value="">{t("普通对话")}</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <div className="empty-composer-row">
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void createTaskFromComposer(); } }} placeholder={t("输入要交给 Codex 的任务")} disabled={!cdpReady || sending || switchingThread} />
            <button className="send-button" onClick={() => void createTaskFromComposer()} disabled={!cdpReady || sending || switchingThread || (!draft.trim() && pendingImages.length === 0)} title={t("发送")}><Send size={19} /></button>
          </div>
          {pendingImages.length > 0 && <div className="pending-images">{pendingImages.map((image) => <div className="pending-image" key={image.id}><img src={image.preview} alt={image.file.name} /><button type="button" onClick={() => removeImage(image.id)} title={t("移除 {name}", { name: image.file.name })} disabled={sending}><X size={14} /></button></div>)}</div>}
          <div className="empty-composer-actions">
            <button className="attach-button" type="button" onClick={() => imageInputRef.current?.click()} disabled={!cdpReady || sending || pendingImages.length >= 4} title={t("添加图片")}><ImagePlus size={16} /><span>{t("添加")}</span></button>
            <input ref={imageInputRef} className="image-file-input" type="file" accept="image/avif,image/gif,image/jpeg,image/png,image/webp" multiple onChange={(event) => { addImages(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
          </div>
        </div>}{needsPairing && pairingInfo?.urls[0] && <section className="pairing-qr" aria-label={t("手机扫码连接")}><div className="pairing-qr-code"><QRCodeSVG value={pairingInfo.urls[0]} size={196} level="M" marginSize={1} /></div><div className="pairing-qr-copy"><strong>{t("用手机扫码使用")}</strong><span>{t("打开手机相机扫描二维码，将自动连接这台电脑。")}</span><small>{t("配对码")} {pairingInfo.pairingCode}</small></div></section>}{error && <div className="error-bar"><CircleAlert size={16} />{error}</div>}{needsPairing && <form className="token-form" onSubmit={(event) => void pairDevice(event)} aria-busy={pairing}><input value={pairingCode} onChange={(event) => setPairingCode(event.target.value)} placeholder={t("配对码")} aria-label={t("配对码")} autoComplete="one-time-code" disabled={pairing} /><button type="submit" disabled={pairing || !pairingCode.trim()}>{pairing && <LoaderCircle className="spin" size={16} aria-hidden="true" />}{pairing ? t("正在配对") : t("开始配对")}</button></form>}</div>}
    </section>
    <EnvironmentPanel info={envInfo} sourcesExpanded={envSourcesExpanded} onToggleSources={() => setEnvSourcesExpanded((v) => !v)} cwd={selectedThread?.cwd ?? null} />
    {dialog && <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !dialogBusy) setDialog(null); }}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <header><h2 id="dialog-title">{dialog === "task" ? t("新建任务") : dialog === "project" ? t("创建项目") : dialog === "follow-up" ? t("任务正在运行") : permissionConfirm ? t("确认完全访问") : t("Desktop 权限")}</h2><button className="icon-button" onClick={() => { setDialog(null); setPermissionConfirm(false); }} disabled={dialogBusy} title={t("关闭")}><X size={19} /></button></header>
        {dialog === "follow-up" ? <div className="follow-up-options">
          <p className="follow-up-intro">{t("这条消息将作为正在运行任务的后续指令发送：")}</p>
          <div className="follow-up-preview">{pendingImages.length > 0 && <span className="follow-up-image-count">{t("已附加 {count} 张图片", { count: pendingImages.length })}</span>}{followUpContent}</div>
          {followUpModes.map((option) => {
            const Icon = option.icon;
            return <button key={option.mode} type="button" className={`permission-option follow-up-option ${option.mode}`} onClick={() => void submitFollowUp(option.mode)} disabled={dialogBusy}>
              <span className="permission-option-icon">{followUpSubmitting === option.mode ? <LoaderCircle className="spin" size={19} /> : <Icon size={19} />}</span>
              <span><strong>{t(option.title)}</strong><small>{t(option.description)}</small></span>
            </button>;
          })}
          {error && <div className="dialog-error"><CircleAlert size={16} />{error}</div>}
        </div> : dialog === "permissions" ? permissionConfirm ? <div className="permission-confirm">
          <span className="permission-confirm-icon"><ShieldAlert size={22} /></span>
          <strong>{t("允许不受限制的访问？")}</strong>
          <p>{t("Codex 将无需批准即可访问互联网、运行命令，并读取、修改或删除这台电脑上的任意文件。")}</p>
          {error && <div className="dialog-error"><CircleAlert size={16} />{error}</div>}
          <div className="dialog-actions"><button type="button" className="secondary" onClick={() => setPermissionConfirm(false)} disabled={dialogBusy}>{t("返回")}</button><button type="button" className="danger-primary" onClick={() => void changePermissionMode("full-access")} disabled={dialogBusy}>{dialogBusy && <LoaderCircle className="spin" size={16} />}{dialogBusy ? t("正在同步") : t("开启完全访问")}</button></div>
        </div> : <div className="permission-options">
          {permissionModes.map((option) => {
            const Icon = option.icon;
            const selectedMode = desktopPermissions.mode === option.mode;
            return <button key={option.mode} type="button" className={`permission-option ${option.mode}${selectedMode ? " selected" : ""}`} onClick={() => void changePermissionMode(option.mode)} disabled={dialogBusy || selectedMode} aria-pressed={selectedMode}>
              <span className="permission-option-icon">{dialogBusy && !selectedMode ? <LoaderCircle className="spin" size={19} /> : <Icon size={19} />}</span>
              <span><strong>{t(option.title)}</strong><small>{t(option.description)}</small></span>
              {selectedMode && <Check size={18} />}
            </button>;
          })}
          {error && <div className="dialog-error"><CircleAlert size={16} />{error}</div>}
        </div> : dialog === "task" ? <form onSubmit={(event) => void createTask(event)}>
          <label className="field"><span>{t("文件夹")}</span><select value={newTaskProjectId} onChange={(event) => setNewTaskProjectId(event.target.value)} disabled={dialogBusy}><option value="">{t("不选择文件夹（普通对话）")}</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
          <label className="field"><span>{t("第一条消息")}</span><textarea value={newTaskContent} onChange={(event) => setNewTaskContent(event.target.value)} placeholder={t("输入要交给 Codex 的任务")} disabled={dialogBusy} autoFocus /></label>
          <div className="dialog-actions"><button type="button" className="secondary" onClick={() => setDialog(null)} disabled={dialogBusy}>{t("取消")}</button><button type="submit" className="primary" disabled={dialogBusy || !newTaskContent.trim()}>{dialogBusy && <LoaderCircle className="spin" size={16} />}{dialogBusy ? t("正在创建") : t("创建并发送")}</button></div>
        </form> : <form onSubmit={(event) => void createProject(event)}>
          <label className="field"><span>{t("项目名称")}</span><input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder={t("留空则使用文件夹名称")} disabled={dialogBusy} autoFocus /></label>
          <label className="field"><span>{t("项目文件夹路径")}</span><div className="path-row"><input value={projectPath} onChange={(event) => setProjectPath(event.target.value)} placeholder={t("例如 C:\\Users\\你的用户名\\Desktop\\项目")} disabled={dialogBusy} /><button type="button" className="path-pick" onClick={() => openFolderBrowser()} disabled={dialogBusy || folderBrowserOpen} title={t("浏览远程电脑文件夹")}><FolderSearch size={16} />{t("浏览...")}</button></div></label>
          <div className="dialog-actions"><button type="button" className="secondary" onClick={() => setDialog(null)} disabled={dialogBusy}>{t("取消")}</button><button type="submit" className="primary" disabled={dialogBusy || !projectPath.trim()}>{dialogBusy && <LoaderCircle className="spin" size={16} />}{dialogBusy ? t("正在添加") : t("添加项目")}</button></div>
        </form>}
      </section>
    </div>}
    {folderBrowserOpen && <FolderBrowser
      onSelect={(path) => { setProjectPath(path); setFolderBrowserOpen(false); }}
      onClose={() => setFolderBrowserOpen(false)}
    />}
  </main>;
}

function FolderBrowser({ onSelect, onClose }: { onSelect: (path: string) => void; onClose: () => void }) {
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [directories, setDirectories] = useState<{ name: string; path: string }[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadPath(dirPath: string | null) {
    setLoading(true);
    setError("");
    try {
      if (dirPath === null) {
        const result = await api<{ home?: string; roots?: { name: string; path: string }[] }>("/api/fs/roots");
        const roots = Array.isArray(result.roots) ? result.roots : [];
        setCurrentPath(null);
        setParent(null);
        setDirectories(roots);
        if (!roots.length) setError(t("没有可浏览的目录，请确认 Bridge 已重启到最新版本"));
      } else {
        const result = await api<{ current?: string | null; parent?: string | null; directories?: { name: string; path: string }[]; error?: string }>(`/api/fs/list?path=${encodeURIComponent(dirPath)}`);
        setCurrentPath(typeof result.current === "string" ? result.current : dirPath);
        setParent(typeof result.parent === "string" ? result.parent : null);
        setDirectories(Array.isArray(result.directories) ? result.directories : []);
        if (result.error) setError(result.error);
      }
    } catch (cause) {
      setError(friendlyError(cause));
      setDirectories([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadPath(null); }, []);

  return <div className="dialog-backdrop folder-browser-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="dialog folder-browser" role="dialog" aria-modal="true" aria-labelledby="folder-browser-title">
      <header>
        <h2 id="folder-browser-title">{t("选择文件夹")}</h2>
        <button className="icon-button" onClick={onClose} title={t("关闭")}><X size={19} /></button>
      </header>
      <div className="folder-browser-body">
        <div className="folder-browser-path" title={currentPath ?? t("快捷位置")}>
          <span className="folder-breadcrumb">{currentPath ?? t("快捷位置")}</span>
        </div>
        {loading ? <div className="folder-browser-loading"><LoaderCircle className="spin" size={20} />{t("加载中…")}</div>
          : error ? <div className="error-bar"><CircleAlert size={16} />{error}</div>
          : <div className="folder-browser-list">
            {currentPath === null ? null : <button type="button" className="folder-browser-item parent" onClick={() => void loadPath(parent)}>{parent ? t("返回上级") : t("返回快捷位置")}</button>}
            {directories.length === 0 ? <div className="folder-browser-empty">{t("此目录没有子文件夹")}</div> : directories.map((entry) => (
              <button key={entry.path} type="button" className="folder-browser-item" onClick={() => void loadPath(entry.path)} title={entry.path}>
                <Folder size={16} /><span>{entry.name}</span>
              </button>
            ))}
          </div>}
      </div>
      <div className="folder-browser-actions">
        <button type="button" className="secondary" onClick={onClose}>{t("取消")}</button>
        <button type="button" className="primary" onClick={() => { if (currentPath) onSelect(currentPath); }} disabled={!currentPath}>{t("选择此文件夹")}</button>
      </div>
    </section>
  </div>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
