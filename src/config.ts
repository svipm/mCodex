import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const host = process.env.BRIDGE_HOST ?? "127.0.0.1";
const configuredToken = process.env.BRIDGE_TOKEN?.trim() ?? "";
const external = !["127.0.0.1", "localhost", "::1"].includes(host);
const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const tokenFile = process.env.BRIDGE_TOKEN_FILE?.trim() || path.join(codexHome, "remote-bridge-token");

function discoverCdpUrl(): string {
  const configured = process.env.CODEX_CDP_URL?.trim();
  if (configured) return configured;

  try {
    const saved = readFileSync(path.join(os.tmpdir(), "mcodex-cdp-url"), "utf8").trim();
    if (/^https?:\/\/127\.0\.0\.1:\d+$/.test(saved)) return saved;
  } catch {
    // Codex++ writes this file after starting its random CDP port.
  }

  return "http://localhost:9222";
}

function persistentToken(): { value: string; persisted: boolean } {
  if (!external) return { value: "", persisted: false };
  if (configuredToken) return { value: configuredToken, persisted: false };

  try {
    const saved = readFileSync(tokenFile, "utf8").trim();
    if (/^[A-Za-z0-9_-]{24,}$/.test(saved)) return { value: saved, persisted: true };
  } catch {
    // The token file is created below on the first external start.
  }

  const generated = crypto.randomBytes(32).toString("base64url");
  try {
    mkdirSync(path.dirname(tokenFile), { recursive: true });
    writeFileSync(tokenFile, `${generated}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(tokenFile, 0o600);
    return { value: generated, persisted: true };
  } catch (error) {
    console.warn(`无法保存 Bridge 设备信任令牌：${error instanceof Error ? error.message : String(error)}`);
    return { value: generated, persisted: false };
  }
}

const resolvedToken = persistentToken();
const token = configuredToken || resolvedToken.value;

if (external && token.length < 24) {
  throw new Error("BRIDGE_TOKEN must contain at least 24 characters when BRIDGE_HOST is not loopback");
}

export const config = {
  host,
  external,
  tokenGenerated: external && !configuredToken && !resolvedToken.persisted,
  tokenPersisted: external && !configuredToken && resolvedToken.persisted,
  tokenFile,
  port: Number(process.env.BRIDGE_PORT ?? 3210),
  token,
  codexHome,
  cdpUrl: discoverCdpUrl(),
  scanIntervalMs: Number(process.env.BRIDGE_SCAN_INTERVAL_MS ?? 500),
};
