import { errorMessage } from "../errors";
import type { GitRunner } from "../git/runner";
import {
	readTaskBehaviorsIfExists,
	type TaskBehavior,
	validateTaskBehaviors,
	writeTaskBehaviors,
} from "../storage/behavior-store";
import type { PlannerFs } from "../storage/fs";
import {
	createTaskStoragePaths,
	type ProjectStoragePaths,
} from "../storage/paths";
import { readPlanRecord } from "../storage/plan-store";
import { readSpecRecordIfExists } from "../storage/spec-store";
import { readTaskRecord } from "../storage/task-store";
import {
	checkPlannerOrchestratorToolAllowed,
	runPlannerOrchestrator,
} from "./orchestrator";
import { asObject, requiredString } from "./params";
import { blockedResult } from "./tool-result";

export const PLANNER_BEHAVIOR_TOOL_NAME = "planner_behavior_upsert" as const;
export type PlannerBehaviorToolName = typeof PLANNER_BEHAVIOR_TOOL_NAME;

/**
 * The toggle board (SDD execution phase): persist the task's full behavior
 * list with per-behavior statuses. Enumerate at write_tdd_plan (all
 * `planned`), flip to `red` as each named failing test lands, to `green`
 * when it passes. The tdd_coverage gate compiles this file and NAMES every
 * behavior still missing the phase's witness.
 */
export async function executePlannerBehaviorTool(input: {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
	params: unknown;
}) {
	const orchestrator = await runPlannerOrchestrator(input);
	if (orchestrator.preflight.context.status !== "ready") {
		return blocked(orchestrator.preflight.context.reason);
	}
	const policy = checkPlannerOrchestratorToolAllowed({
		orchestrator,
		toolName: PLANNER_BEHAVIOR_TOOL_NAME,
	});
	if (!policy.allow) {
		return blocked(
			policy.reason ?? "planner_behavior_upsert is blocked by planner state.",
		);
	}
	try {
		const { planPaths, state } = orchestrator.preflight.context;
		const params = asObject(input.params);
		const taskId = requiredString(params, "taskId");
		if (state.activeTaskId && state.activeTaskId !== taskId) {
			return blocked(
				`The active task is ${state.activeTaskId}, not ${taskId}. Behaviors belong to the task being executed.`,
			);
		}
		const plan = await readPlanRecord(input.fs, planPaths);
		if (!plan.tasks.some((task) => task.taskId === taskId)) {
			return blocked(
				`Task ${taskId} does not exist in this plan. Create it first with planner_task_upsert.`,
			);
		}
		const taskPaths = createTaskStoragePaths(planPaths, taskId);
		const previous = await readTaskBehaviorsIfExists(input.fs, taskPaths);
		const record = validateTaskBehaviors({
			taskId,
			behaviors: (params.behaviors ?? []) as TaskBehavior[],
			previous,
		});
		// Spec traceability, when both sides exist: a behavior citing REQ-n must
		// cite a real, in-scope requirement that this task actually owns
		// (task.requirements) — otherwise the coverage totality binds the wrong set.
		const spec = await readSpecRecordIfExists(input.fs, planPaths);
		if (spec) {
			const task = await readTaskRecord(input.fs, taskPaths);
			const owned = new Set(task.requirements ?? []);
			for (const behavior of record.behaviors) {
				if (!behavior.requirement) continue;
				const known = spec.requirements.find(
					(req) => req.id === behavior.requirement,
				);
				if (!known?.inScope) {
					return blocked(
						`Behavior ${behavior.id} cites ${behavior.requirement}, which is ${known ? "out of scope" : "not"} in spec.json. Use exact in-scope REQ-n ids or null.`,
					);
				}
				if (!owned.has(behavior.requirement)) {
					return blocked(
						`Behavior ${behavior.id} cites ${behavior.requirement}, but task ${taskId} does not own it (task.requirements). Cite a REQ-n this task discharges, or add it to the task via planner_task_upsert.`,
					);
				}
			}
		}
		await writeTaskBehaviors(input.fs, taskPaths, record);
		const byStatus = { planned: 0, red: 0, green: 0 };
		for (const behavior of record.behaviors) {
			byStatus[behavior.status] += 1;
		}
		return {
			status: "applied" as const,
			toolName: PLANNER_BEHAVIOR_TOOL_NAME,
			text: [
				`Behavior board for ${taskId} written: ${record.behaviors.length} behaviors — ${byStatus.planned} planned, ${byStatus.red} red, ${byStatus.green} green.`,
				`Registry: ${taskPaths.behaviorsJson}`,
				"",
				...record.behaviors.map(
					(behavior) =>
						`- ${behavior.id} [${behavior.status}] (${behavior.kind}${behavior.requirement ? `, ${behavior.requirement}` : ""}) ${behavior.statement}${behavior.test ? ` — ${behavior.test.file} :: ${behavior.test.name}` : ""}`,
				),
				"",
				'Any earlier tdd_coverage gate pass is now stale. Run planner_gate_check with gate: "tdd_coverage" to see what the machine still counts as uncovered.',
			].join("\n"),
			details: { record },
		};
	} catch (error) {
		return blocked(errorMessage(error));
	}
}

function blocked(text: string) {
	return blockedResult(PLANNER_BEHAVIOR_TOOL_NAME, text);
}
