import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  GOAL_SUBAGENT_SERVICE,
  type GoalSubagentBridge,
  type GoalSubagentServiceRequest,
  type GoalSubagentTask,
  type ReasoningEffort,
} from "./subagent-bridge.ts";

const STATE_TYPE = "goal-state";
const MAX_OBJECTIVE_LENGTH = 4_000;
const MIN_EVIDENCE_LENGTH = 20;

interface GoalState {
  id: string;
  objective: string;
  status: "active" | "complete";
  createdAt: number;
  updatedAt: number;
  reviewerId?: string;
  lastEvidence?: string;
  completionPending?: boolean;
}

function latestGoalState(ctx: ExtensionContext): GoalState | undefined {
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
    const value = entry.data as Record<string, unknown> | undefined;
    if (
      !value ||
      typeof value.id !== "string" ||
      typeof value.objective !== "string" ||
      typeof value.createdAt !== "number" ||
      typeof value.updatedAt !== "number"
    ) {
      continue;
    }
    if (value.status === "cleared") return undefined;
    return {
      id: value.id,
      objective: value.objective,
      status: value.status === "complete" ? "complete" : "active",
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      reviewerId:
        typeof value.reviewerId === "string" ? value.reviewerId : undefined,
      lastEvidence:
        typeof value.lastEvidence === "string" ? value.lastEvidence : undefined,
      completionPending: value.completionPending === true,
    };
  }
  return undefined;
}

type Theme = ExtensionContext["ui"]["theme"];

function statusLine(state: GoalState, theme: Theme) {
  const status = state.completionPending ? "reviewing" : state.status;
  return `${theme.fg("muted", "goal:")} ${theme.fg("accent", "/goal")}${theme.fg("muted", ` · ${status}`)}`;
}

function describe(state: GoalState | undefined) {
  if (!state) return "No goal.";
  const lines = [
    `Goal ${state.id}: ${state.completionPending ? "reviewing" : state.status}`,
    state.objective,
  ];
  if (state.lastEvidence) lines.push(`Evidence: ${state.lastEvidence}`);
  return lines.join("\n");
}

function parentTask(ctx: ExtensionContext, prompt: string): GoalSubagentTask {
  return {
    prompt,
    title: "goal reviewer",
    cwd: ctx.cwd,
    parentCwd: ctx.cwd,
    projectTrusted: ctx.isProjectTrusted(),
    inheritedModel: ctx.model
      ? { provider: ctx.model.provider, id: ctx.model.id }
      : undefined,
    inheritedThinkingLevel: ctx.thinkingLevel,
    modelRegistry: ctx.modelRegistry,
    reasoningEffort: "high" satisfies ReasoningEffort,
  };
}

export default function goalExtension(pi: ExtensionAPI) {
  let state: GoalState | undefined;
  let sessionContext: ExtensionContext | undefined;
  let continuationPending = false;
  let reviewInFlight = false;

  const getBridge = (): GoalSubagentBridge | undefined => {
    let bridge: GoalSubagentBridge | undefined;
    pi.events.emit(GOAL_SUBAGENT_SERVICE, {
      provide(service: GoalSubagentBridge) {
        bridge = service;
      },
    } satisfies GoalSubagentServiceRequest);
    return bridge;
  };

  const save = () => {
    if (state) pi.appendEntry(STATE_TYPE, { ...state });
  };

  const render = () => {
    if (!sessionContext?.hasUI || !state || state.status === "complete") {
      sessionContext?.ui.setStatus("goal", undefined);
      return;
    }
    sessionContext.ui.setStatus(
      "goal",
      statusLine(state, sessionContext.ui.theme),
    );
  };

  const update = (patch: Partial<GoalState>) => {
    if (!state) return;
    state = { ...state, ...patch, updatedAt: Date.now() };
    save();
    render();
  };

  const queue = (prompt: string) => {
    if (state?.status !== "active" || continuationPending) return;
    continuationPending = true;
    pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  };

  const cancelReviewer = async () => {
    if (!state?.reviewerId) return;
    try {
      await getBridge()?.cancel([state.reviewerId]);
    } catch {
      // Best effort during completion, reload, and shutdown.
    }
  };

  const stop = () => {
    if (state?.status !== "active") return;
    const stopped = { ...state, status: "cleared", updatedAt: Date.now() };
    void cancelReviewer();
    state = undefined;
    continuationPending = false;
    pi.appendEntry(STATE_TYPE, stopped);
    render();
    sessionContext?.ui.notify("Goal stopped.", "info");
  };

  const reviewerPrompt = (goal: GoalState) =>
    `
You are the final verification subagent for a long-running Pi goal.
Do not edit files, commit, or push. Inspect the current working tree and run safe, relevant checks when useful.
Goal: ${goal.objective}
The main agent claims completion with this evidence:
${goal.lastEvidence ?? "(none)"}
Report what appears complete, what remains, and exact failing checks. Treat the goal as incomplete unless the evidence is strong.
If and only if every requirement is satisfied and verification supports completion, include the exact marker GOAL_REVIEW: COMPLETE; otherwise include GOAL_REVIEW: INCOMPLETE.
`.trim();

  const reviewCompletion = async (ctx: ExtensionContext) => {
    if (
      reviewInFlight ||
      state?.status !== "active" ||
      !state.completionPending
    )
      return;
    const bridge = getBridge();
    if (!bridge) {
      update({ status: "complete", completionPending: false });
      sessionContext?.ui.notify("Goal complete.", "info");
      return;
    }

    reviewInFlight = true;
    const goalId = state.id;
    try {
      const reviewer = await bridge.spawn(
        parentTask(ctx, reviewerPrompt(state)),
      );
      if (state?.id !== goalId || state.status !== "active") return;
      update({ reviewerId: reviewer.id });
      await bridge.waitFor([reviewer.id]);
      const result = await bridge.get(reviewer.id);
      if (state?.id !== goalId || state.status !== "active") return;
      const report =
        result?.finalText?.slice(0, 12_000) || "Reviewer returned no report.";
      if (
        report.includes("GOAL_REVIEW: COMPLETE") &&
        report.length >= MIN_EVIDENCE_LENGTH
      ) {
        update({
          status: "complete",
          completionPending: false,
          reviewerId: undefined,
        });
        sessionContext?.ui.notify(
          "Goal complete; independent review passed.",
          "info",
        );
        return;
      }
      update({ completionPending: false, reviewerId: undefined });
      queue(
        `Continue the goal using this independent review. Address all remaining work, verify it, and call goal_complete only when every requirement is satisfied.\n\nGoal: ${state.objective}\n\nReviewer report:\n${report}`,
      );
    } catch {
      if (state?.id === goalId && state.status === "active") {
        update({ reviewerId: undefined });
        queue(
          `Continue working until this goal is complete. The reviewer was unavailable, so inspect and verify the work yourself.\n\nGoal: ${state.objective}`,
        );
      }
    } finally {
      reviewInFlight = false;
    }
  };

  const start = (prompt: string) => {
    queue(
      `${prompt}\n\nWork in verified checkpoints and call goal_complete only when every requirement is satisfied.\n\nGoal: ${state?.objective}`,
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    await cancelReviewer();
    sessionContext = ctx;
    state = latestGoalState(ctx);
    continuationPending = false;
    reviewInFlight = false;
    render();
    if (state?.status === "active")
      start("Resume this unfinished goal from the current workspace state.");
  });

  pi.on("session_tree", async (_event, ctx) => {
    await cancelReviewer();
    sessionContext = ctx;
    state = latestGoalState(ctx);
    continuationPending = false;
    reviewInFlight = false;
    render();
    if (state?.status === "active")
      start("Resume this unfinished goal from the current workspace state.");
  });

  pi.on("agent_start", () => {
    continuationPending = false;
  });

  pi.on("turn_end", (event) => {
    if ((event.message as { stopReason?: string }).stopReason === "aborted")
      stop();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (state?.status !== "active" || continuationPending) return;
    if (state.completionPending) {
      void reviewCompletion(ctx);
    } else {
      queue(
        `Continue working until this goal is complete. Inspect the current state, make the next concrete change, and verify it.\n\nGoal: ${state.objective}`,
      );
    }
  });

  pi.on("before_agent_start", (event) => {
    if (state?.status !== "active") return;
    return {
      systemPrompt: `${event.systemPrompt}\n\nACTIVE GOAL\nObjective: ${state.objective}\n\nKeep working until the objective is fully reached. Do not stop for turn counts, token usage, failed attempts, or lack of progress. Use available subagents for independent or parallelizable work when that helps. Do not claim completion without concrete evidence. Use goal_complete only when every requirement is satisfied. If subagents are available, the extension uses one for final verification.`,
    };
  });

  pi.on("session_shutdown", async () => {
    await cancelReviewer();
    sessionContext = undefined;
    continuationPending = false;
    reviewInFlight = false;
  });

  pi.registerTool({
    name: "goal_complete",
    label: "Complete Goal",
    description:
      "Mark the active goal complete. Include concrete evidence from files, tests, or other verification.",
    parameters: Type.Object({
      evidence: Type.String({ minLength: MIN_EVIDENCE_LENGTH }),
    }),
    async execute(_toolCallId, params: { evidence: string }) {
      if (state?.status !== "active")
        throw new Error("There is no active goal.");
      const evidence = params.evidence.trim();
      if (evidence.length < MIN_EVIDENCE_LENGTH)
        throw new Error("Completion evidence is too short.");
      update({ completionPending: true, lastEvidence: evidence });
      return {
        content: [
          {
            type: "text",
            text: "Completion claim recorded. An independent reviewer will verify it before the goal is closed.",
          },
        ],
        details: state,
      };
    },
  });

  const beginGoal = async (objective: string, ctx: ExtensionCommandContext) => {
    if (state?.status === "active") {
      ctx.ui.notify(
        "A goal is already active. It must be completed before another can start.",
        "warning",
      );
      return;
    }
    await ctx.waitForIdle();
    const now = Date.now();
    state = {
      id: `goal-${now.toString(36)}`,
      objective,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    continuationPending = false;
    save();
    render();
    ctx.ui.notify(`Goal started: ${objective}`, "info");
    start("Start pursuing this goal now.");
  };

  pi.registerCommand("goal", {
    description: "Start or inspect a goal that runs until complete",
    handler: async (rawArgs, ctx) => {
      const objective = rawArgs.trim();
      if (!objective) {
        ctx.ui.notify(describe(state), "info");
        return;
      }
      if (objective.length > MAX_OBJECTIVE_LENGTH) {
        ctx.ui.notify(
          `Goal objectives are limited to ${MAX_OBJECTIVE_LENGTH} characters.`,
          "error",
        );
        return;
      }
      await beginGoal(objective, ctx);
    },
  });
}
