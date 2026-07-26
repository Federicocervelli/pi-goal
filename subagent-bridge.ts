import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export const GOAL_SUBAGENT_SERVICE = "subagents:goal-service";
export type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface GoalSubagentTask { prompt: string; title: string; cwd: string; model?: string; reasoningEffort?: ReasoningEffort; parentCwd: string; projectTrusted: boolean; inheritedModel?: { provider: string; id: string }; inheritedThinkingLevel?: string; modelRegistry?: ModelRegistry; }
export interface GoalSubagentSnapshot { id: string; finalText?: string; }
export interface GoalSubagentBridge { spawn(task: GoalSubagentTask): Promise<GoalSubagentSnapshot>; waitFor(ids: ReadonlyArray<string>): Promise<void>; get(id: string): Promise<GoalSubagentSnapshot | undefined>; cancel(ids: ReadonlyArray<string>): Promise<unknown>; }
export interface GoalSubagentServiceRequest { provide(service: GoalSubagentBridge): void; }
