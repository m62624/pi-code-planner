import { errorMessage } from "../errors";
import type { GitRunner } from "../git/runner";
import type { PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import { readPlanRecord, updatePlanRecord } from "../storage/plan-store";
import { readSpecRecordIfExists } from "../storage/spec-store";
import { upsertTaskArtifacts } from "../storage/task-store";
import { ARTIFACT_CANONICAL_SCHEMA, formatArtifactEcho } from "./artifact-echo";
import {
	checkPlannerOrchestratorToolAllowed,
	runPlannerOrchestrator,
} from "./orchestrator";
import {
	nonEmptyStringArray,
	type ParamSchema,
	parseParams,
	stringArray,
	trimmedString,
} from "./param-codec";
import { blockedResult } from "./tool-result";

export const PLANNER_TASK_TOOL_NAMES = ["planner_task_upsert"] as const;
export type PlannerTaskToolName = (typeof PLANNER_TASK_TOOL_NAMES)[number];

const TASK_UPSERT_SCHEMA = {
	taskId: trimmedString(),
	title: trimmedString(),
	objective: trimmedString(),
	scope: stringArray(),
	acceptanceCriteria: nonEmptyStringArray(
		"Each criterion is one observable, testable outcome.",
	),
	requirements: stringArray("Cite exact REQ-n ids from spec.json."),
	dependsOn: stringArray("taskIds this task builds on — not REQ-n ids."),
	contractChain: stringArray(),
	relevantContracts: stringArray(),
	forbiddenAreas: stringArray(),
	domainDetails: stringArray(),
} satisfies ParamSchema;

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
		const parsed = parseParams(
			input.toolName,
			TASK_UPSERT_SCHEMA,
			input.params,
		);
		if (!parsed.ok) {
			return blocked(input.toolName, parsed.error);
		}
		const { taskId, requirements } = parsed.value;
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
		// Traceability by identity (REQ-2): every cited id must exist in the
		// spec and be in scope — a typo'd or de-scoped id would silently satisfy
		// the coverage gate for nothing.
		const spec = await readSpecRecordIfExists(
			input.fs,
			orchestrator.preflight.context.planPaths,
		);
		if (requirements.length > 0 && !spec) {
			return blocked(
				input.toolName,
				"This task cites spec requirements but the plan has no spec.json. Author the spec first (spec/draft_requirements) or omit `requirements` for a legacy plan.",
			);
		}
		if (spec) {
			for (const requirement of requirements) {
				const known = spec.requirements.find((req) => req.id === requirement);
				if (!known) {
					return blocked(
						input.toolName,
						`Task ${taskId} cites ${requirement}, which does not exist in spec.json. Use exact REQ-n ids from the spec (or add the requirement via planner_spec_submit and re-verify the spec).`,
					);
				}
				if (!known.inScope) {
					return blocked(
						input.toolName,
						`Task ${taskId} cites ${requirement}, which the spec marks out of scope. De-scoped requirements must not receive tasks (REQ-3).`,
					);
				}
			}
		}
		const result = await upsertTaskArtifacts(
			input.fs,
			orchestrator.preflight.context.planPaths,
			parsed.value,
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
	return blockedResult(toolName, text);
}
