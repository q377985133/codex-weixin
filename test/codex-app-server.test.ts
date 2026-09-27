import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { HybridCodexRunner } from "../src/codex/runner.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

test("uses the Codex V2 initialize, thread, and turn lifecycle", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());

  const deltas: string[] = [];
  const progress: string[] = [];
  const first = await runner.run({
    prompt: "first",
    cwd: "/tmp/project",
    model: "test-model",
    effort: "high",
    onDelta: async (delta) => {
      deltas.push(delta);
    },
    onProgress: async (message) => {
      progress.push(message);
    }
  });
  assert.equal(first.threadId, "thread-new");
  assert.equal(first.text, "reply:first");
  assert.deepEqual(deltas, ["reply:", "first"]);
  assert.deepEqual(progress, ["working:first"]);
  assert.match(first.raw, /item\/completed/);
  assert.match(first.raw, /turn\/completed/);
  assert.deepEqual(await runner.getRuntimeInfo("/tmp/project", "thread-new"), {
    model: "test-model",
    effort: "high"
  });

  const resumed = await runner.run({
    prompt: "second",
    cwd: "/tmp/project",
    threadId: "thread-existing"
  });
  assert.equal(resumed.threadId, "thread-existing");
  assert.equal(resumed.text, "reply:second");
  assert.deepEqual(await runner.getRuntimeInfo("/tmp/project", "thread-existing"), {
    model: "resumed-model",
    effort: "medium"
  });

  assert.deepEqual(await runner.listSessions(), {
    data: [{ id: "thread-new" }],
    nextCursor: null,
    backwardsCursor: null
  });

  assert.deepEqual(await runner.getHistory("thread-existing"), [
    {
      id: "history-user-1",
      role: "user",
      text: "hello history",
      createdAt: "2023-11-14T22:13:20.000Z"
    },
    {
      id: "history-commentary-1",
      role: "assistant",
      text: "working",
      kind: "progress",
      createdAt: "2023-11-14T22:13:22.000Z"
    },
    {
      id: "history-assistant-1",
      role: "assistant",
      text: "history reply",
      createdAt: "2023-11-14T22:13:22.000Z"
    }
  ]);

  assert.deepEqual(await runner.getRuntimeInfo("/tmp/another-project"), {
    model: "configured-model",
    effort: "high",
    provider: "FixtureProvider"
  });
  assert.deepEqual(await runner.listModels(), [{
    model: "configured-model",
    displayName: "Configured Model",
    description: "Model used by the test fixture.",
    isDefault: true,
    defaultEffort: "medium",
    supportedEfforts: [
      { effort: "medium", description: "Balanced" },
      { effort: "high", description: "Deeper reasoning" }
    ]
  }]);
});

test("interrupts the active V2 turn with both threadId and turnId", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());

  const run = runner.run({ prompt: "hold", cwd: "/tmp/project", threadId: "thread-stop" });
  const outcome = run.then(
    (value) => ({ value, error: undefined }),
    (error: Error) => ({ value: undefined, error })
  );
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    await runner.stop("thread-stop");
  }
  const result = await outcome;
  assert.match(result.error?.message ?? "", /interrupted/i);
});

test("auto backend falls back to codex exec for an existing thread", async (t) => {
  const runner = new HybridCodexRunner({
    backend: "auto",
    codexBin: path.join(fixturesDir, "fake-codex-fallback.mjs"),
    timeoutMs: 2_000
  });
  t.after(() => runner.close());

  const result = await runner.run({
    prompt: "continue",
    cwd: fixturesDir,
    threadId: "thread-existing"
  });

  assert.equal(result.threadId, "thread-existing");
  assert.match(result.text, /used codex exec fallback/i);
  assert.match(result.text, /exec-resumed/);
});

test("exec backend uses app-server when true streaming is requested", async (t) => {
  const runner = new HybridCodexRunner({
    backend: "exec",
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    timeoutMs: 2_000
  });
  t.after(() => runner.close());
  const deltas: string[] = [];

  const result = await runner.run({
    prompt: "stream",
    cwd: fixturesDir,
    onDelta: (delta) => {
      deltas.push(delta);
    }
  });

  assert.deepEqual(deltas, ["reply:", "stream"]);
  assert.equal(result.text, "reply:stream");
});

test("streaming fallback to exec sends only the final answer", async (t) => {
  const runner = new HybridCodexRunner({
    backend: "exec",
    codexBin: path.join(fixturesDir, "fake-codex-fallback.mjs"),
    timeoutMs: 2_000
  });
  t.after(() => runner.close());
  const deltas: string[] = [];

  const result = await runner.run({
    prompt: "stream",
    cwd: fixturesDir,
    onDelta: (delta) => {
      deltas.push(delta);
    }
  });

  assert.deepEqual(deltas, []);
  assert.match(result.text, /used codex exec fallback/i);
  assert.match(result.text, /exec-new/);
});

test("lists local Codex sessions across app-server sources", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());

  const sessions = await runner.listCodexSessions({ searchTerm: "迷宫" });

  assert.deepEqual(sessions, [{
    id: "thread-external",
    title: "迷宫闯关游戏",
    preview: "继续完善迷宫地图与关卡",
    workspace: "/tmp/external-project",
    source: "vscode",
    updatedAt: "2023-11-14T22:15:00.000Z",
    model: "gpt-test",
    effort: "high"
  }]);
});

test("sets a Codex goal and streams subsequent automatic turns", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());

  const progress: string[] = [];
  let resolveFinal: ((value: string) => void) | undefined;
  const final = new Promise<string>((resolve) => {
    resolveFinal = resolve;
  });

  const result = await runner.setGoal({
    threadId: "thread-existing",
    cwd: "/tmp/project",
    objective: "完成迷宫闯关游戏的下一个关卡",
    status: "active",
    onProgress: (message) => {
      progress.push(message);
    },
    onFinal: (result) => {
      resolveFinal?.(result.text);
    }
  });

  assert.equal(result.threadId, "thread-existing");
  assert.equal(result.goal.objective, "完成迷宫闯关游戏的下一个关卡");
  assert.equal(await final, "reply:完成迷宫闯关游戏的下一个关卡");
  assert.deepEqual(progress, ["working:完成迷宫闯关游戏的下一个关卡"]);
  assert.equal((await runner.getGoal("thread-existing"))?.status, "complete");
  assert.equal(await runner.clearGoal("thread-existing"), true);
});
