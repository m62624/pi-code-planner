import { errorMessage } from "../errors";
import type { GitRunner } from "../git/runner";
import {
	readTaskBehaviorsIfExists,
	type TaskBehavior,
	type TaskBehaviorsRecord,
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
		let ownedRequirements: readonly string[] = [];
		let coverableRequirements: ReadonlySet<string> | null = null;
		if (spec) {
			const task = await readTaskRecord(input.fs, taskPaths);
			ownedRequirements = task.requirements ?? [];
			const owned = new Set(ownedRequirements);
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
			coverableRequirements = new Set(
				spec.requirements
					.filter((req) => req.inScope && req.deferral === undefined)
					.map((req) => req.id),
			);
		}
		const nudges = computeBehaviorBoardNudges({
			previous,
			record,
			ownedRequirements,
			coverableRequirements,
		});
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
				...nudges,
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

/**
 * Break the two silent traps a behavior write can fall into. Upsert MERGES, so a
 * resubmit that omits `requirement` re-persists an identical board — the model
 * then reads a bare "written" and loops on the same list (seen live: 13 identical
 * resubmits). And the tdd_coverage gate hard-blocks on any in-scope owned REQ that
 * no behavior cites, a gap the model otherwise only discovers by round-tripping
 * through the gate. Naming both here, on the write itself, is a nudge (never a
 * block): the board is already saved.
 */
export function computeBehaviorBoardNudges(input: {
	previous: TaskBehaviorsRecord | null;
	record: TaskBehaviorsRecord;
	/** task.requirements (every REQ-n the task cites), empty for legacy plans. */
	ownedRequirements: readonly string[];
	/** In-scope, non-deferred spec REQ-n ids; null when the plan has no spec. */
	coverableRequirements: ReadonlySet<string> | null;
}): string[] {
	const lines: string[] = [];
	const unchanged =
		input.previous !== null &&
		JSON.stringify(input.previous.behaviors) ===
			JSON.stringify(input.record.behaviors);
	if (unchanged) {
		lines.push(
			"",
			"No change: this board is identical to the one already saved — resubmitting the same list will NOT advance the tdd_coverage gate. To move forward, flip a status, attach a test witness, or set `requirement` on a behavior.",
		);
	}
	if (input.coverableRequirements) {
		const cited = new Set(
			input.record.behaviors
				.map((behavior) => behavior.requirement)
				.filter((req): req is string => Boolean(req)),
		);
		const uncoveredOwned = [...new Set(input.ownedRequirements)]
			.filter((id) => input.coverableRequirements?.has(id) && !cited.has(id))
			.sort();
		if (uncoveredOwned.length > 0) {
			lines.push(
				"",
				`Owned requirements no behavior cites yet: ${uncoveredOwned.join(", ")}. The tdd_coverage gate BLOCKS until each is exercised — set \`requirement\` to that single REQ-n string (e.g. "requirement": "${uncoveredOwned[0]}") on the behavior that verifies it, then resubmit the FULL list.`,
			);
		}
	}
	return lines;
}
