import { describe, expect, it } from "vitest";
import { extractImages, extractSources, extractText, extractTokenUsage, extractUserText, inferStatus, isVisibleTimelineItem, rollbackTurnsFromRecord, statusFromEvent, timelineFromRecord, timelineFromRecords } from "./parser.js";
import { normalizeText } from "./store.js";

describe("session parser", () => {
  it("extracts structured message content", () => {
    expect(extractText([{ type: "input_text", text: "hello" }, { type: "input_text", text: "world" }])).toBe("hello\nworld");
  });

  it("extracts multimodal images and keeps image-only messages visible", () => {
    expect(extractImages([
      { type: "input_text", text: "look" },
      { type: "input_image", image_url: "data:image/png;base64,abc", name: "paste.png" },
      { type: "local_image", path: "C:\\Temp\\shot.webp" },
    ])).toEqual([
      { source: "data:image/png;base64,abc", alt: "paste.png" },
      { source: "C:\\Temp\\shot.webp", alt: "图片 3" },
    ]);
    expect(timelineFromRecord({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_image", image_url: { url: "https://example.com/a.png" } }] } }, "thread", 2))
      .toMatchObject({ kind: "message", role: "user", text: "", images: [{ source: "https://example.com/a.png" }] });
  });

  it("hides Desktop attachment metadata from user messages", () => {
    const content = [
      {
        type: "input_text",
        text: "\n# Files mentioned by the user:\n\n## clipboard.png: C:/Users/name/AppData/Local/Temp/clipboard.png\n\n## My request for Codex:\n只显示这段正文\n",
      },
      { type: "input_text", text: '<image name=[Image #1] path="C:\\Temp\\clipboard.png">' },
      { type: "input_image", image_url: "data:image/png;base64,abc" },
      { type: "input_text", text: "</image>" },
    ];

    expect(extractUserText(content)).toBe("只显示这段正文");
    expect(timelineFromRecord({ type: "response_item", payload: { type: "message", role: "user", content } }, "thread", 3))
      .toMatchObject({ text: "只显示这段正文", images: [{ source: "data:image/png;base64,abc" }] });
  });

  it("does not rewrite ordinary user Markdown", () => {
    const text = "## My request for Codex:\n这是用户主动输入的标题";
    expect(extractUserText([{ type: "input_text", text }])).toBe(text);
  });

  it("maps tool calls and lifecycle state", () => {
    const item = timelineFromRecord({ timestamp: "2026-01-01T00:00:00Z", type: "response_item", payload: { type: "custom_tool_call", name: "shell", input: { command: "pwd" } } }, "thread", 10);
    expect(item?.kind).toBe("tool_call");
    expect(item).toMatchObject({ text: "shell", activity: { type: "command" } });
    expect(item && isVisibleTimelineItem(item)).toBe(true);
    expect(inferStatus([{ type: "event_msg", payload: { type: "task_started" } }])).toBe("running");
    expect(inferStatus([{ type: "event_msg", payload: { type: "task_complete" } }])).toBe("completed");
  });

  it("keeps recent tool activity as running when lifecycle events are sparse", () => {
    expect(inferStatus([
      { type: "event_msg", payload: { type: "task_started" } },
      { type: "response_item", payload: { type: "function_call", name: "shell_command" } },
      { type: "event_msg", payload: { type: "token_count" } },
    ])).toBe("running");
    expect(inferStatus([
      { type: "event_msg", payload: { type: "task_started" } },
      { type: "event_msg", payload: { type: "task_complete" } },
      { type: "event_msg", payload: { type: "token_count" } },
    ])).toBe("completed");
  });

  it("shows compact reasoning progress without markdown wrappers", () => {
    const item = timelineFromRecord({ type: "event_msg", payload: { type: "agent_reasoning", text: "**Planning concurrent work**" } }, "thread", 14);
    expect(item).toMatchObject({ kind: "reasoning", text: "Planning concurrent work" });
    expect(item && isVisibleTimelineItem(item)).toBe(true);
  });

  it("caps anomalously large reasoning events for remote timelines", () => {
    const item = timelineFromRecord({ type: "event_msg", payload: { type: "agent_reasoning", text: "x".repeat(10_000) } }, "thread", 15);
    expect(item?.text).toHaveLength(4_000);
    expect(item?.text.endsWith("…")).toBe(true);
  });

  it("reads successful file changes from the structured completion event", () => {
    const item = timelineFromRecord({
      type: "event_msg",
      payload: {
        type: "patch_apply_end",
        success: true,
        changes: {
          "C:\\work\\app.ts": { type: "update", unified_diff: "@@ -1,2 +1,3 @@\n-old\n+new\n+extra\n same" },
          "C:\\work\\new.ts": { type: "add", content: "first\nsecond\n" },
        },
      },
    }, "thread", 16);
    expect(item).toMatchObject({
      text: "patch_apply_end",
      eventType: "patch_apply_end",
      activity: {
        type: "file_change",
        fileCount: 2,
        additions: 4,
        deletions: 1,
        files: [
          { path: "C:\\work\\app.ts", additions: 2, deletions: 1 },
          { path: "C:\\work\\new.ts", additions: 2, deletions: 0 },
        ],
      },
    });
    expect(item && isVisibleTimelineItem(item)).toBe(true);
  });

  it("does not show failed patch completion events", () => {
    const item = timelineFromRecord({ type: "event_msg", payload: { type: "patch_apply_end", success: false, changes: {} } }, "thread", 18);
    expect(item).toBeNull();
  });

  it("normalizes ProseMirror paragraph spacing", () => {
    expect(normalizeText("first\n\nsecond\r\n")).toBe("first\nsecond");
  });

  it("recognizes approval wait events", () => {
    expect(statusFromEvent("permission_request")).toBe("waiting_approval");
  });

  it("hides injected desktop context messages", () => {
    const item = timelineFromRecord({ type: "response_item", payload: { type: "message", role: "user", content: [{ text: "<environment_context>internal</environment_context>" }] } }, "thread", 12);
    expect(item).toBeNull();
  });

  it("removes rolled-back turns before building the visible timeline", () => {
    const records = [
      { offset: 0, record: { type: "response_item", payload: { type: "message", role: "user", content: [{ text: "first prompt" }] } } },
      { offset: 10, record: { type: "response_item", payload: { type: "message", role: "assistant", content: [{ text: "obsolete answer" }] } } },
      { offset: 20, record: { type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } } },
      { offset: 30, record: { type: "response_item", payload: { type: "message", role: "user", content: [{ text: "replacement prompt" }] } } },
    ];

    expect(rollbackTurnsFromRecord(records[2].record)).toBe(1);
    expect(timelineFromRecords(records, "thread").map((item) => item.text)).toEqual(["replacement prompt"]);
  });

  it("can roll back more than one completed turn", () => {
    const records = [
      { offset: 0, record: { type: "response_item", payload: { type: "message", role: "user", content: [{ text: "one" }] } } },
      { offset: 10, record: { type: "response_item", payload: { type: "message", role: "assistant", content: [{ text: "answer one" }] } } },
      { offset: 20, record: { type: "response_item", payload: { type: "message", role: "user", content: [{ text: "two" }] } } },
      { offset: 30, record: { type: "response_item", payload: { type: "message", role: "assistant", content: [{ text: "answer two" }] } } },
      { offset: 40, record: { type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 2 } } },
    ];

    expect(timelineFromRecords(records, "thread")).toEqual([]);
  });

  it("extracts unique source URLs from assistant messages only", () => {
    const records = [
      { offset: 0, record: { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "https://user.example.com/ignored" }] } } },
      { offset: 10, record: { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "See https://example.com/a and https://example.com/a (again)." }] } } },
      { offset: 20, record: { type: "event_msg", payload: { type: "token_count" } } },
      { offset: 30, record: { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Details: https://example.com/b?q=1&x=2" }] } } },
    ];

    expect(extractSources(records)).toEqual(["https://example.com/a", "https://example.com/b?q=1&x=2"]);
  });

  it("caps source extraction at 20 unique URLs", () => {
    const records = Array.from({ length: 25 }, (_, index) => ({
      offset: index,
      record: { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `https://example.com/item/${index}` }] } },
    }));

    const sources = extractSources(records);
    expect(sources).toHaveLength(20);
    expect(new Set(sources).size).toBe(20);
  });

  it("extracts the latest token usage event with camel and snake case", () => {
    const records = [
      { offset: 0, record: { type: "event_msg", payload: { type: "token_count", input_tokens: 100, output_tokens: 20, cached_tokens: 30, total_tokens: 150, model_name: "gpt-5", cost_usd: 0.05 } } },
      { offset: 10, record: { type: "event_msg", payload: { type: "token_count", inputTokens: 200, outputTokens: 40, cacheTokens: 60, totalTokens: 300, model: "gpt-5.2", cost: 0.1 } } },
    ];

    expect(extractTokenUsage(records)).toEqual({
      inputTokens: 200,
      outputTokens: 40,
      cacheTokens: 60,
      cacheHitRate: 0.2,
      totalTokens: 300,
      cost: 0.1,
      model: "gpt-5.2",
    });
  });

  it("returns null when no token usage event exists", () => {
    expect(extractTokenUsage([])).toBeNull();
    expect(extractTokenUsage([{ offset: 0, record: { type: "event_msg", payload: { type: "agent_reasoning" } } }])).toBeNull();
  });
});
