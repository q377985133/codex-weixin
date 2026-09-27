import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createIsolatedCodexHome, stripExternalIntegrations } from "../src/codex/isolated-home.js";

test("removes MCP and plugin sections while retaining other Codex config", () => {
  const config = [
    'model = "gpt-test"',
    "",
    "[mcp_servers.figma]",
    'command = "figma"',
    "",
    "[plugins.example]",
    'enabled = true',
    "",
    "[model_providers.example]",
    'name = "Example"'
  ].join("\n");

  const stripped = stripExternalIntegrations(config);
  assert.match(stripped, /model = "gpt-test"/);
  assert.match(stripped, /\[model_providers\.example]/);
  assert.doesNotMatch(stripped, /mcp_servers|plugins/);
});

test("creates an isolated Codex home and links non-config state", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-isolated-source-"));
  const sourceHome = path.join(root, "source");
  fs.mkdirSync(path.join(sourceHome, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(sourceHome, "config.toml"), [
    'model = "gpt-test"',
    "",
    "[mcp_servers.figma]",
    'command = "figma"'
  ].join("\n"));
  fs.writeFileSync(path.join(sourceHome, "auth.json"), "{}");

  const isolated = createIsolatedCodexHome(sourceHome);
  t.after(() => {
    isolated.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.equal(fs.readFileSync(path.join(isolated.path, "config.toml"), "utf8"), 'model = "gpt-test"\n');
  assert.equal(fs.lstatSync(path.join(isolated.path, "auth.json")).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(isolated.path, "sessions")).isSymbolicLink(), true);
});
