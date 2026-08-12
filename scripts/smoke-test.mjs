import WebSocket from "ws";

const baseUrl = (process.env.MCODEX_SMOKE_URL ?? "http://127.0.0.1:3210").replace(/\/+$/, "");
const checks = [];

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

async function check(name, fn) {
  try {
    const detail = await fn();
    checks.push({ name, ok: true });
    console.log(`ok   ${name}${detail ? ` (${detail})` : ""}`);
  } catch (error) {
    checks.push({ name, ok: false });
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("timed out waiting for WebSocket message"));
    }, 10_000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      socket.close();
      resolve(String(data));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

await check("health", async () => {
  const health = await getJson("/api/health");
  if (!health.ok) throw new Error("health is not ok");
  return "ok";
});

let status;
await check("desktop connected", async () => {
  status = (await getJson("/api/status")).cdp;
  if (!status?.connected) throw new Error("Codex control is not connected");
  if (!status.editorReady) throw new Error("Codex editor is not ready");
  if (!status.currentThreadId) throw new Error("no current thread");
  return `thread=${status.currentThreadId}`;
});

await check("thread list", async () => {
  const threads = (await getJson("/api/threads")).threads;
  if (!Array.isArray(threads) || threads.length === 0) throw new Error("no threads found");
  return `${threads.length} threads`;
});

await check("environment info", async () => {
  const info = await getJson(`/api/threads/${status.currentThreadId}/environment`);
  if (!("git" in info) || !("tokenUsage" in info) || !("sources" in info)) {
    throw new Error("environment payload is missing expected fields");
  }
  return `branch=${info.git?.branch ?? "none"}`;
});

await check("websocket desktop_state", async () => {
  const wsUrl = `ws://${new URL(baseUrl).host}/ws`;
  const message = await openWebSocket(wsUrl);
  const payload = JSON.parse(message);
  if (payload.type !== "desktop_state" || !payload.status?.connected) {
    throw new Error("first message is not a connected desktop_state");
  }
  return "ok";
});

const failed = checks.filter((item) => !item.ok).length;
if (failed > 0) {
  console.error(`SMOKE FAIL: ${failed}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`SMOKE PASS: ${checks.length}/${checks.length} checks passed`);
