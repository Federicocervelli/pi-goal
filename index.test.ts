import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import goalExtension from "./index.ts";

test("exposes only the goal command and completion tool", () => {
  const commands: string[] = [];
  const tools: string[] = [];
  const pi = {
    events: { emit() {} },
    on() {},
    registerCommand(name: string) {
      commands.push(name);
    },
    registerTool(tool: { name: string }) {
      tools.push(tool.name);
    },
  } as unknown as ExtensionAPI;

  goalExtension(pi);

  assert.deepEqual(commands, ["goal"]);
  assert.deepEqual(tools, ["goal_complete"]);
});

test("completed goals do not remain in the status line", async () => {
  let sessionStart:
    ((event: unknown, ctx: ExtensionContext) => unknown) | undefined;
  const statuses: unknown[] = [];
  const pi = {
    events: { emit() {} },
    on(
      name: string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown,
    ) {
      if (name === "session_start") sessionStart = handler;
    },
    registerCommand() {},
    registerTool() {},
    sendUserMessage() {
      assert.fail("A completed goal must not restart");
    },
  } as unknown as ExtensionAPI;
  const now = Date.now();
  const ctx = {
    hasUI: true,
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: "goal-state",
          data: {
            id: "goal-done",
            objective: "done",
            status: "complete",
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    },
    ui: { setStatus: (_key: string, status: unknown) => statuses.push(status) },
  } as unknown as ExtensionContext;

  goalExtension(pi);
  assert.ok(sessionStart);
  await sessionStart({}, ctx);

  assert.deepEqual(statuses, [undefined]);
});

test("Escape abort stops an active goal instead of continuing it", async () => {
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  let goalCommand:
    ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const entries: Array<{ customType: string; data: any }> = [];
  const messages: string[] = [];
  const statuses: unknown[] = [];
  const notifications: string[] = [];
  const pi = {
    events: { emit() {} },
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand(
      name: string,
      command: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) {
      if (name === "goal") goalCommand = command.handler;
    },
    registerTool() {},
    appendEntry(customType: string, data: any) {
      entries.push({ customType, data });
    },
    sendUserMessage(message: string) {
      messages.push(message);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    sessionManager: { getBranch: () => [] },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: (_key: string, status: unknown) => statuses.push(status),
      notify: (message: string) => notifications.push(message),
    },
    waitForIdle: async () => {},
  } as unknown as ExtensionCommandContext;

  goalExtension(pi);
  for (const handler of handlers.get("session_start") ?? [])
    await handler({}, ctx as ExtensionContext);
  assert.ok(goalCommand);
  await goalCommand("pause", ctx);
  for (const handler of handlers.get("agent_start") ?? []) handler({});
  for (const handler of handlers.get("turn_end") ?? [])
    handler({ message: { stopReason: "aborted" } }, ctx);
  for (const handler of handlers.get("agent_settled") ?? []) handler({}, ctx);

  assert.equal(messages.length, 1);
  assert.equal(entries.at(-1)?.data.status, "cleared");
  assert.equal(statuses.at(-1), undefined);
  assert.equal(notifications.at(-1), "Goal stopped.");
});
