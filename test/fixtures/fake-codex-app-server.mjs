#!/usr/bin/env node

import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
let initialized = false;
let nextTurn = 1;
const activeTurns = new Map();
const goals = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ id, result });
}

function fail(id, message) {
  send({ id, error: { code: -32602, message } });
}

function completedTurn(id, status, error = null) {
  return {
    id,
    items: [],
    itemsView: "full",
    status,
    error,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1
  };
}

function beginTurn(threadId, prompt) {
  const turnId = `turn-${nextTurn++}`;
  activeTurns.set(threadId, turnId);
  send({
    method: "turn/started",
    params: { threadId, turn: completedTurn(turnId, "inProgress") }
  });
  setTimeout(() => {
    const progressItemId = `progress-${turnId}`;
    send({
      method: "item/started",
      params: {
        threadId,
        turnId,
        item: { type: "agentMessage", id: progressItemId, text: "", phase: "commentary", memoryCitation: null }
      }
    });
    send({
      method: "item/agentMessage/delta",
      params: { threadId, turnId, itemId: progressItemId, delta: `working:${prompt}` }
    });
    send({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        completedAtMs: Date.now(),
        item: { type: "agentMessage", id: progressItemId, text: `working:${prompt}`, phase: "commentary", memoryCitation: null }
      }
    });
    const itemId = `item-${turnId}`;
    send({
      method: "item/started",
      params: {
        threadId,
        turnId,
        item: { type: "agentMessage", id: itemId, text: "", phase: "final_answer", memoryCitation: null }
      }
    });
    for (const delta of ["reply:", prompt]) {
      send({
        method: "item/agentMessage/delta",
        params: { threadId, turnId, itemId, delta }
      });
    }
    send({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        completedAtMs: Date.now(),
        item: { type: "agentMessage", id: itemId, text: `reply:${prompt}`, phase: "final_answer", memoryCitation: null }
      }
    });
    send({
      method: "turn/completed",
      params: { threadId, turn: completedTurn(turnId, "completed") }
    });
    activeTurns.delete(threadId);
  }, 5);
  return turnId;
}

rl.on("line", (line) => {
  const message = JSON.parse(line);

  if (message.method === "initialize") {
    if (message.jsonrpc) {
      fail(message.id, "jsonrpc header must be omitted");
      return;
    }
    if (message.params?.clientInfo?.name !== "codex-weixin") {
      fail(message.id, "missing codex-weixin clientInfo");
      return;
    }
    respond(message.id, {
      userAgent: "fake-codex",
      codexHome: "/tmp/fake-codex-home",
      platformFamily: "unix",
      platformOs: "test"
    });
    return;
  }

  if (message.method === "initialized") {
    initialized = true;
    return;
  }

  if (!initialized) {
    fail(message.id, "Not initialized");
    return;
  }

  if (message.method === "thread/start") {
    if (message.params?.approvalPolicy !== "never") {
      fail(message.id, "approvalPolicy must be never");
      return;
    }
    respond(message.id, {
      thread: { id: "thread-new" },
      model: message.params.model ?? "configured-model",
      reasoningEffort: "high"
    });
    return;
  }

  if (message.method === "thread/resume") {
    respond(message.id, {
      thread: { id: message.params.threadId },
      model: "resumed-model",
      reasoningEffort: "medium"
    });
    return;
  }

  if (message.method === "config/read") {
    respond(message.id, {
      config: {
        model: "configured-model",
        model_provider: "FixtureProvider",
        model_reasoning_effort: "high"
      },
      origins: {}
    });
    return;
  }

  if (message.method === "model/list") {
    respond(message.id, {
      data: [{
        id: "configured-model",
        model: "configured-model",
        displayName: "Configured Model",
        description: "Model used by the test fixture.",
        hidden: false,
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "Balanced" },
          { reasoningEffort: "high", description: "Deeper reasoning" }
        ],
        defaultReasoningEffort: "medium",
        isDefault: true
      }],
      nextCursor: null
    });
    return;
  }

  if (message.method === "thread/list") {
    if (Array.isArray(message.params?.sourceKinds)) {
      const sessions = [
        {
          id: "thread-external",
          preview: "继续完善迷宫地图与关卡",
          name: "迷宫闯关游戏",
          cwd: "/tmp/external-project",
          source: "vscode",
          updatedAt: 1_700_000_100,
          model: "gpt-test",
          reasoningEffort: "high"
        },
        {
          id: "thread-other",
          preview: "整理季度报告",
          name: "季度报告",
          cwd: "/tmp/reports",
          source: "cli",
          updatedAt: 1_700_000_000,
          model: null,
          reasoningEffort: null
        }
      ];
      const searchTerm = String(message.params?.searchTerm ?? "").toLowerCase();
      const filtered = searchTerm
        ? sessions.filter((session) => session.name.toLowerCase().includes(searchTerm))
        : sessions;
      respond(message.id, { data: filtered, nextCursor: null, backwardsCursor: null });
      return;
    }
    respond(message.id, { data: [{ id: "thread-new" }], nextCursor: null, backwardsCursor: null });
    return;
  }

  if (message.method === "thread/goal/set") {
    const previous = goals.get(message.params.threadId);
    const objective = typeof message.params.objective === "string"
      ? message.params.objective
      : previous?.objective;
    const status = message.params.status ?? previous?.status ?? "active";
    if (!objective) {
      fail(message.id, "objective is required for a new goal");
      return;
    }
    const goal = {
      threadId: message.params.threadId,
      objective,
      status,
      tokenBudget: message.params.tokenBudget ?? null,
      tokensUsed: previous?.tokensUsed ?? 0,
      timeUsedSeconds: previous?.timeUsedSeconds ?? 0,
      createdAt: previous?.createdAt ?? 1_700_000_000,
      updatedAt: 1_700_000_001
    };
    goals.set(message.params.threadId, goal);
    respond(message.id, { goal });
    send({
      method: "thread/goal/updated",
      params: { threadId: goal.threadId, turnId: null, goal }
    });
    if (status === "active" && !activeTurns.has(goal.threadId)) {
      beginTurn(goal.threadId, goal.objective);
      setTimeout(() => {
        const completed = { ...goal, status: "complete", updatedAt: 1_700_000_002 };
        goals.set(goal.threadId, completed);
        send({
          method: "thread/goal/updated",
          params: { threadId: goal.threadId, turnId: null, goal: completed }
        });
      }, 1);
    }
    return;
  }

  if (message.method === "thread/goal/get") {
    respond(message.id, { goal: goals.get(message.params.threadId) ?? null });
    return;
  }

  if (message.method === "thread/goal/clear") {
    const cleared = goals.delete(message.params.threadId);
    respond(message.id, { cleared });
    if (cleared) {
      send({ method: "thread/goal/cleared", params: { threadId: message.params.threadId } });
    }
    return;
  }

  if (message.method === "thread/read") {
    respond(message.id, {
      thread: {
        id: message.params.threadId,
        turns: [
          {
            id: "history-turn-1",
            status: "completed",
            startedAt: 1_700_000_000,
            completedAt: 1_700_000_002,
            items: [
              {
                type: "userMessage",
                id: "history-user-1",
                clientId: null,
                content: [{ type: "text", text: "hello history", text_elements: [] }]
              },
              {
                type: "agentMessage",
                id: "history-commentary-1",
                text: "working",
                phase: "commentary",
                memoryCitation: null
              },
              {
                type: "agentMessage",
                id: "history-assistant-1",
                text: "history reply",
                phase: "final_answer",
                memoryCitation: null
              },
              { type: "reasoning", id: "history-reasoning-1", summary: [], content: ["hidden"] }
            ]
          }
        ]
      }
    });
    return;
  }

  if (message.method === "turn/start") {
    const prompt = message.params?.input?.[0]?.text;
    if (message.params?.input?.[0]?.type !== "text" || typeof prompt !== "string") {
      fail(message.id, "turn/start requires text input");
      return;
    }
    const turnId = `turn-${nextTurn++}`;
    activeTurns.set(message.params.threadId, turnId);
    respond(message.id, { turn: completedTurn(turnId, "inProgress") });
    if (prompt === "hold") {
      return;
    }
    setTimeout(() => {
      const progressItemId = `progress-${turnId}`;
      send({
        method: "item/started",
        params: {
          threadId: message.params.threadId,
          turnId,
          item: { type: "agentMessage", id: progressItemId, text: "", phase: "commentary", memoryCitation: null }
        }
      });
      send({
        method: "item/agentMessage/delta",
        params: { threadId: message.params.threadId, turnId, itemId: progressItemId, delta: `working:${prompt}` }
      });
      send({
        method: "item/completed",
        params: {
          threadId: message.params.threadId,
          turnId,
          completedAtMs: Date.now(),
          item: { type: "agentMessage", id: progressItemId, text: `working:${prompt}`, phase: "commentary", memoryCitation: null }
        }
      });
      const itemId = `item-${turnId}`;
      send({
        method: "item/started",
        params: {
          threadId: message.params.threadId,
          turnId,
          item: { type: "agentMessage", id: itemId, text: "", phase: "final_answer", memoryCitation: null }
        }
      });
      for (const delta of ["reply:", prompt]) {
        send({
          method: "item/agentMessage/delta",
          params: { threadId: message.params.threadId, turnId, itemId, delta }
        });
      }
      send({
        method: "item/completed",
        params: {
          threadId: message.params.threadId,
          turnId,
          completedAtMs: Date.now(),
          item: { type: "agentMessage", id: itemId, text: `reply:${prompt}`, phase: "final_answer", memoryCitation: null }
        }
      });
      send({
        method: "turn/completed",
        params: { threadId: message.params.threadId, turn: completedTurn(turnId, "completed") }
      });
      activeTurns.delete(message.params.threadId);
    }, 5);
    return;
  }

  if (message.method === "turn/interrupt") {
    const activeTurnId = activeTurns.get(message.params.threadId);
    if (activeTurnId !== message.params.turnId) {
      fail(message.id, "turn/interrupt used the wrong turnId");
      return;
    }
    respond(message.id, {});
    send({
      method: "turn/completed",
      params: { threadId: message.params.threadId, turn: completedTurn(activeTurnId, "interrupted") }
    });
    activeTurns.delete(message.params.threadId);
    return;
  }

  fail(message.id, `unsupported method: ${message.method}`);
});
