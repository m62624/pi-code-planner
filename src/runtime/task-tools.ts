import { errorMessage } from "../errors";
import type { GitRunner } from "../git/runner";
import type { PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import { readPlanRecord, updatePlanRecord } from "../storage/plan-store";
import { upsertTaskArtifacts } from "../storage/task-store";
import { ARTIFACT_CANONICAL_SCHEMA, formatArtifactEcho } from "./artifact-echo";
import {
	checkPlannerOrchestratorToolAllowed,
	runPlannerOrchestrator,
} from "./orchestrator";
import { requiredString } from "./params";
import { asObject } from "./values";

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
				contractChain: stringArray(params.contractChain ?? [], "contractChain"),
				relevantContracts: stringArray(
					params.relevantContracts ?? [],
					"relevantContracts",
				),
				forbiddenAreas: stringArray(
					params.forbiddenAreas ?? [],
					"forbiddenAreas",
				),
				domainDetails: stringArray(params.domainDetails ?? [], "domainDetails"),
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
				"",
				formatArtifactEcho({
					canonicalSchema: ARTIFACT_CANONICAL_SCHEMA.planner_task_upsert,
					writtenMarkdown: await input.fs.readText(result.paths.taskMd),
				}),
				"",
				"TDD lifecycle artifacts were created if missing. Do not create a separate testing task.",
				"Call planner_status before choosing the next planner action.",
			].join("\n"),
			details: result,
		};
	} catch (error) {
		return blocked(input.toolName, errorMessage(error));
	}
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

function stringArray(value: unknown, key: string): string[] {
	if (
		!Array.isArray(value) ||
		!value.every((entry) => typeof entry === "string")
	) {
		throw new TypeError(`${key} must be a string array.`);
	}
	return value;
}
