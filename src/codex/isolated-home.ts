import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Creates a private Codex home for the bridge process. User auth and model
 * provider settings are retained, while global MCP/plugin sections are left
 * out so an unrelated integration cannot break a WeChat turn.
 */
export function createIsolatedCodexHome(
  sourceHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")
): { path: string; cleanup: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-home-"));
  const sourceConfig = path.join(sourceHome, "config.toml");
  if (fs.existsSync(sourceConfig)) {
    fs.writeFileSync(
      path.join(home, "config.toml"),
      stripExternalIntegrations(fs.readFileSync(sourceConfig, "utf8")),
      "utf8"
    );
  }
  for (const entry of safeReadDirectory(sourceHome)) {
    if (entry === "config.toml") {
      continue;
    }
    const source = path.join(sourceHome, entry);
    const target = path.join(home, entry);
    try {
      fs.symlinkSync(source, target, fs.statSync(source).isDirectory() ? "dir" : "file");
    } catch {
      // A concurrently created entry is harmless; the isolated config remains authoritative.
    }
  }
  return {
    path: home,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true })
  };
}

export function stripExternalIntegrations(config: string): string {
  const lines = config.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line)?.[1];
    if (section) {
      skipping = /^(?:mcp_servers|plugins)(?:\.|$)/.test(section);
    }
    if (!skipping) {
      kept.push(line);
    }
  }
  return kept.join("\n");
}

function safeReadDirectory(directory: string): string[] {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}
