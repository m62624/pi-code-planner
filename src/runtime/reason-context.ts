import { readTaskBehaviorsIfExists } from "../storage/behavior-store";
import type { PlannerFs } from "../storage/fs";
import type { PlanStoragePaths } from "../storage/paths";
import { createTaskStoragePaths } from "../storage/paths";
import { readPlanRecordIfExists } from "../storage/plan-store";
import type { PlanStateRecord, TaskRecord } from "../storage/schema";
import { readSpecRecordIfExists } from "../storage/spec-store";
import { readTaskRecord } from "../storage/task-store";
import { readElenchusLastCheck } from "./elenchus-tools";
import type { FuelLastCheck, ReasoningFuel } from "./reasoning-fuel";
import {
	computeReasoningFuel,
	coverageFromLastCheck,
	frictionFromLastCheck,
	sharedTaskSurfaces,
	warrantedWebFromBranches,
	warrantedWebFromSpecConstraints,
} from "./reasoning-fuel";

/**
 * Assembles reasoning fuel for the current step by loading only the planner's
 * OWN artifacts — the spec's constraints, the active task's declared branches,
 * the plan's shared task surfaces — plus its own last-check record. Nothing
 * here reads the engine's report. This is the bridge the reason tool and the
 * status line both call so fuel is computed one way everywhere.
 *
 * The warranted web per step mirrors where a real interacting-condition web
 * lives: the spec's constraints at consistency_check, the task's branches at
 * the two execution reasoning steps, the plan's shared surfaces at
 * doubt_review. Steps with no measurable web (the discovery scan, the recovery
 * repair) return 0, so fuel is null there and the directive stays silent.
 */

export interface StepReasoningFuel {
	fuel: ReasoningFuel;
	/** Plural noun for the web at this step, for the directive to name. */
	webNoun: string;
}

interface StepWeb {
	warrantedWeb: number;
	webNoun: string;
}

async function warrantedWebForStep(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
	state: PlanStateRecord,
): Promise<StepWeb> {
	if (state.stage === "planning" && state.step === "consistency_check") {
		const spec = await readSpecRecordIfExists(fs, planPaths);
		return {
			warrantedWeb: spec ? warrantedWebFromSpecConstraints(spec) : 0,
			webNoun: "spec constraints",
		};
	}
	if (
		state.stage === "execution" &&
		(state.step === "write_tdd_plan" || state.step === "contract_check")
	) {
		return {
			warrantedWeb: await countActiveTaskBranches(fs, planPaths, state),
			webNoun: "declared branches",
		};
	}
	if (state.stage === "finalize" && state.step === "doubt_review") {
		const tasks = await loadAllTaskRecords(fs, planPaths);
		return {
			warrantedWeb: sharedTaskSurfaces(tasks),
			webNoun: "shared task surfaces",
		};
	}
	return { warrantedWeb: 0, webNoun: "" };
}

async function countActiveTaskBranches(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
	state: PlanStateRecord,
): Promise<number> {
	const taskId = state.activeTaskId;
	if (!taskId) return 0;
	const record = await readTaskBehaviorsIfExists(
		fs,
		createTaskStoragePaths(planPaths, taskId),
	);
	if (!record) return 0;
	const branches = record.behaviors.flatMap((behavior) => behavior.branches);
	return warrantedWebFromBranches(branches);
}

async function loadAllTaskRecords(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
): Promise<TaskRecord[]> {
	const plan = await readPlanRecordIfExists(fs, planPaths);
	if (!plan) return [];
	const records: TaskRecord[] = [];
	for (const summary of plan.tasks) {
		try {
			records.push(
				await readTaskRecord(
					fs,
					createTaskStoragePaths(planPaths, summary.taskId),
				),
			);
		} catch {
			// A summary without a materialized task.json yet contributes no scope.
		}
	}
	return records;
}

/**
 * Compute the current step's reasoning fuel. `stale` (from a world run's own
 * anchor sweep) and `lastCheck` may be passed in to avoid re-reading them right
 * after a run; both default to a fresh read / zero.
 */
export async function loadStepReasoningFuel(input: {
	fs: PlannerFs;
	planPaths: PlanStoragePaths;
	state: PlanStateRecord;
	stale?: number;
	lastCheck?: FuelLastCheck | null;
}): Promise<StepReasoningFuel> {
	const { fs, planPaths, state } = input;
	const { warrantedWeb, webNoun } = await warrantedWebForStep(
		fs,
		planPaths,
		state,
	);
	const lastCheck =
		input.lastCheck !== undefined
			? input.lastCheck
			: await readElenchusLastCheck(fs, planPaths.elenchusDir);
	const coverage = coverageFromLastCheck({
		warrantedWeb,
		lastCheck,
		stage: state.stage,
		step: state.step,
	});
	const fuel = computeReasoningFuel({
		warrantedWeb,
		coverage,
		stale: input.stale ?? 0,
		friction: frictionFromLastCheck(lastCheck),
	});
	return { fuel, webNoun };
}
