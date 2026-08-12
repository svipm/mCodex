import { describe, expect, it } from "vitest";
import { isCodexPermissionMode, isDesktopMode, isFollowUpMode, isReasoningEffort, permissionModeFromLabel, selectCurrentStreamingText, selectRecentThreadIds, shouldUseAlternateFollowUpShortcut } from "./controller.js";

describe("permissionModeFromLabel", () => {
  it.each([
    ["请求批准", "ask"],
    ["Ask for approval", "ask"],
    ["替我审批", "auto"],
    ["Approve for me", "auto"],
    ["完全访问", "full-access"],
    ["Full access", "full-access"],
  ] as const)("maps %s to %s", (label, expected) => {
    expect(permissionModeFromLabel(label)).toBe(expected);
  });

  it("returns null for unavailable or unknown labels", () => {
    expect(permissionModeFromLabel(null)).toBeNull();
    expect(permissionModeFromLabel("自定义")).toBeNull();
  });
});

describe("isCodexPermissionMode", () => {
  it("accepts only supported modes", () => {
    expect(["ask", "auto", "full-access"].every(isCodexPermissionMode)).toBe(true);
    expect(isCodexPermissionMode("custom")).toBe(false);
    expect(isCodexPermissionMode(null)).toBe(false);
  });
});

describe("isDesktopMode", () => {
  it("accepts only supported Desktop modes", () => {
    expect(["codex", "chatgpt-work"].every(isDesktopMode)).toBe(true);
    expect(isDesktopMode("chatgpt")).toBe(false);
    expect(isDesktopMode(null)).toBe(false);
  });
});

describe("isReasoningEffort", () => {
  it("accepts only supported reasoning efforts", () => {
    expect(["low", "medium", "high", "xhigh"].every(isReasoningEffort)).toBe(true);
    expect(isReasoningEffort("max")).toBe(false);
    expect(isReasoningEffort(null)).toBe(false);
  });
});

describe("isFollowUpMode", () => {
  it("accepts the Desktop follow-up modes only", () => {
    expect(["queue", "steer", "interrupt"].every(isFollowUpMode)).toBe(true);
    expect(isFollowUpMode("unknown")).toBe(false);
    expect(isFollowUpMode(null)).toBe(false);
  });
});

describe("shouldUseAlternateFollowUpShortcut", () => {
  it("uses Desktop's default steer behavior when no preference is stored", () => {
    expect(shouldUseAlternateFollowUpShortcut(null, "steer")).toBe(false);
    expect(shouldUseAlternateFollowUpShortcut(null, "queue")).toBe(true);
  });

  it("inverts a stored queue preference only for steer requests", () => {
    expect(shouldUseAlternateFollowUpShortcut("queue", "queue")).toBe(false);
    expect(shouldUseAlternateFollowUpShortcut("queue", "steer")).toBe(true);
  });

  it("treats Desktop's transient interrupt value as steer", () => {
    expect(shouldUseAlternateFollowUpShortcut("interrupt", "steer")).toBe(false);
    expect(shouldUseAlternateFollowUpShortcut("interrupt", "queue")).toBe(true);
  });
});

describe("selectCurrentStreamingText", () => {
  it("does not reuse the previous assistant response after a new user message", () => {
    expect(selectCurrentStreamingText([
      { identity: "assistant", content: "previous answer" },
      { identity: "message-user", content: "hello" },
    ])).toBe("");
  });

  it("returns assistant text written after the latest user message", () => {
    expect(selectCurrentStreamingText([
      { identity: "assistant", content: "previous answer" },
      { identity: "message-user", content: "hello" },
      { identity: "assistant", content: "new answer" },
    ])).toBe("new answer");
  });

  it("stops at the latest user message when newer units have no output", () => {
    expect(selectCurrentStreamingText([
      { identity: "assistant", content: "previous answer" },
      { identity: "message-user", content: "hello" },
      { identity: "assistant-reasoning", content: "" },
    ])).toBe("");
  });
});

describe("selectRecentThreadIds", () => {
  it("keeps only visible real threads without a Desktop folder assignment", () => {
    expect(selectRecentThreadIds([
      "local:assigned-thread",
      "local:pure-chat",
      "client-new-thread:temporary",
      "local:pure-chat",
    ], ["local:assigned-thread", "local:historical-thread"])).toEqual(["pure-chat"]);
  });
});
