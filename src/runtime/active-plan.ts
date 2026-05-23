import type { PlannerFs } from "../storage/fs";
import {
	createPlanStoragePaths,
	type PlanStoragePaths,
	type ProjectStoragePaths,
} from "../storage/paths";
import { readPlanRecord } from "../storage/plan-store";
import { readProjectRecordIfExists } from "../storage/project-store";
import type {
	PlanRecord,
	PlanStateRecord,
	ProjectRecord,
} from "../storage/schema";
import { readPlanState, savePlanState } from "../storage/state-store";

export type ActivePlanContextStatus =
	| "ready"
	| "missing_project"
	| "no_active_plan"
	| "missing_plan"
	| "missing_state";

export interface ActivePlanContextReady {
	status: "ready";
	projectPaths: ProjectStoragePaths;
	planPaths: PlanStoragePaths;
	project: ProjectRecord;
	plan: PlanRecord;
	state: PlanStateRecord;
	activePlanId: string;
}

export interface ActivePlanContextUnavailable {
	status: Exclude<ActivePlanContextStatus, "ready">;
	projectPaths: ProjectStoragePaths;
	project: ProjectRecord | null;
	activePlanId: string | null;
	reason: string;
}

export type ActivePlanContext =
	| ActivePlanContextReady
	| ActivePlanContextUnavailable;

export async function readActivePlanContext(input: {
	fs: PlannerFs;
	projectPaths: ProjectStoragePaths;
}): Promise<ActivePlanContext> {
	const project = await readProjectRecordIfExists(input.fs, input.projectPaths);
	if (!project) {
		return unavailable({
			status: "missing_project",
			projectPaths: input.projectPaths,
			project: null,
			activePlanId: null,
			reason: "Project record does not exist.",
		});
	}

	if (!project.activePlanId) {
		return unavailable({
			status: "no_active_plan",
			projectPaths: input.projectPaths,
			project,
			activePlanId: null,
			reason: "Project has no active planner plan.",
		});
	}

	const planPaths = createPlanStoragePaths(
		input.projectPaths,
		project.activePlanId,
	);

	try {
		const plan = await readPlanRecord(input.fs, planPaths);
		const state = await readPlanState(input.fs, planPaths);
		return {
			status: "ready",
			projectPaths: input.projectPaths,
			planPaths,
			project,
			plan,
			state,
			activePlanId: project.activePlanId,
		};
	} catch (error) {
		if (await missing(input.fs, planPaths.planJson)) {
			return unavailable({
				status: "missing_plan",
				projectPaths: input.projectPaths,
				project,
				activePlanId: project.activePlanId,
				reason: `Active plan record is missing: ${planPaths.planJson}`,
			});
		}

		if (await missing(input.fs, planPaths.stateJson)) {
			return unavailable({
				status: "missing_state",
				projectPaths: input.projectPaths,
				project,
				activePlanId: project.activePlanId,
				reason: `Active plan state is missing: ${planPaths.stateJson}`,
			});
		}

		throw error;
	}
}

export async function updateActivePlanState(input: {
	fs: PlannerFs;
	context: ActivePlanContextReady;
	update: (state: PlanStateRecord) => PlanStateRecord;
}): Promise<ActivePlanContextReady> {
	const state = input.update(input.context.state);
	await savePlanState(input.fs, input.context.planPaths, state);
	return { ...input.context, state };
}

function unavailable(
	input: ActivePlanContextUnavailable,
): ActivePlanContextUnavailable {
	return input;
}

async function missing(fs: PlannerFs, path: string): Promise<boolean> {
	return !(await fs.exists(path));
}
