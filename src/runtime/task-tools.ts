import type { GitRunner } from "../git/runner";
import type { PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import { readPlanRecord, updatePlanRecord } from "../storage/plan-store";
import { upsertTaskArtifacts } from "../storage/task-store";
import {
	checkPlannerOrchestratorToolAllowed,
	runPlannerOrchestrator,
} from "./orchestrator";

export const PLANNER_TASK_TOOL_NAMES = ["planner_task_upsert"] as const;
export type PlannerTaskToolName = (typeof PLANNER_TASK_TOOL_NAMES)[number];

export async function executePlannerTaskTool(input: {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
	toolName: PlannerTaskToolName;
	params: unknown;
}) {
	const orchestrator = await runPlannerOrchestrator(input);
	if (orchestrator.preflight.context.status !== "ready") {
		return blocked(input.toolName, orchestrator.preflight.context.reason);
	}
	const policy = checkPlannerOrchestratorToolAllowed({
		orchestrator,
		toolName: input.toolName,
	});
	if (!policy.allow) {
		return blocked(
			input.toolName,
			policy.reason ?? `Planner task tool ${input.toolName} is blocked.`,
		);
	}
	try {
		const params = asObject(input.params);
		const taskId = requiredString(params, "taskId");
		const plan = await readPlanRecord(
			input.fs,
			orchestrator.preflight.context.planPaths,
		);
		const existing = plan.tasks.find((task) => task.taskId === taskId);
		if (existing?.status === "done") {
			return blocked(
				input.toolName,
				`Task ${taskId} is already done. For a follow-up or change request, create a new revision task id instead of reopening completed work.`,
			);
		}
		const result = await upsertTaskArtifacts(
			input.fs,
			orchestrator.preflight.context.planPaths,
			{
				taskId,
				title: requiredString(params, "title"),
				objective: requiredString(params, "objective"),
				scope: stringArray(params.scope, "scope"),
				acceptanceCriteria: stringArray(
					params.acceptanceCriteria,
					"acceptanceCriteria",
				),
			},
		);
		await updatePlanRecord(
			input.fs,
			orchestrator.preflight.context.planPaths,
			(plan) => ({
				...plan,
				tasks: upsertTaskSummary(plan.tasks, {
					taskId: result.record.taskId,
					title: result.record.title,
					status: result.record.status,
				}),
			}),
		);
		return {
			status: "applied" as const,
			toolName: input.toolName,
			text: [
				`Planner task artifacts written: ${result.record.taskId}.`,
				`Task JSON: ${result.paths.taskJson}`,
				`Task Markdown: ${result.paths.taskMd}`,
				"TDD lifecycle artifacts were created if missing. Do not create a separate testing task.",
				"Call planner_status before choosing the next planner action.",
			].join("\n"),
			details: result,
		};
	} catch (error) {
		return blocked(input.toolName, errorMessage(error));
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function upsertTaskSummary<T extends { taskId: string }>(
	tasks: readonly T[],
	task: T,
): T[] {
	const index = tasks.findIndex((entry) => entry.taskId === task.taskId);
	if (index < 0) return [...tasks, task];
	return tasks.map((entry, entryIndex) =>
		entryIndex === index ? task : entry,
	);
}

function blocked(toolName: PlannerTaskToolName, text: string) {
	return { status: "blocked" as const, toolName, text, details: null };
}

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function requiredString(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== "string" || !value.trim()) {
		throw new TypeError(`${key} must be a non-empty string.`);
	}
	return value.trim();
}

function stringArray(value: unknown, key: string): string[] {
	if (
		!Array.isArray(value) ||
		!value.every((entry) => typeof entry === "string")
	) {
		throw new TypeError(`${key} must be a string array.`);
	}
	return value;
}
