import type { GitRunner } from "../git/runner";
import type { PlannerFs } from "../storage/fs";
import type { PlanStoragePaths, ProjectStoragePaths } from "../storage/paths";
import type { MemoryUpdateReason, PlanStateRecord } from "../storage/schema";
import { savePlanState } from "../storage/state-store";
import {
	inspectPlannerRecovery,
	type PlannerRecoveryInspection,
	type PlannerRecoveryIssue,
} from "./recovery";
import { isPlannerStepInStage, type PlannerPosition } from "./state-machine";

export interface PlannerRecoveryResumeInput {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
	planPaths: PlanStoragePaths;
	state: PlanStateRecord;
	target: PlannerPosition;
}

export type PlannerRecoveryResumeResult =
	| {
			status: "applied";
			previousState: PlanStateRecord;
			state: PlanStateRecord;
			inspection: PlannerRecoveryInspection;
			text: string;
	  }
	| {
			status: "blocked";
			state: PlanStateRecord;
			inspection: PlannerRecoveryInspection;
			reason: string;
			text: string;
	  };

const STATE_GATE_ISSUES = new Set<PlannerRecoveryIssue["code"]>([
	"broken_state",
	"user_decision_required",
]);

export async function resumePlannerRecovery(
	input: PlannerRecoveryResumeInput,
): Promise<PlannerRecoveryResumeResult> {
	const inspection = await inspectPlannerRecovery({
		fs: input.fs,
		git: input.git,
		projectPaths: input.projectPaths,
	});
	const blockingIssues = blockingRecoveryIssues(inspection);
	if (blockingIssues.length > 0) {
		return blocked({
			state: input.state,
			inspection,
			reason: `Planner recovery cannot resume while blocking issues remain: ${blockingIssues.map((issue) => issue.code).join(", ")}.`,
		});
	}
	if (input.state.stage !== "recovery") {
		return blocked({
			state: input.state,
			inspection,
			reason:
				"Planner recovery resume is allowed only when state.stage is recovery.",
		});
	}
	if (input.target.stage === "recovery") {
		return blocked({
			state: input.state,
			inspection,
			reason: "Planner recovery cannot resume back into recovery.",
		});
	}
	if (!isValidResumeTarget(input.target)) {
		return blocked({
			state: input.state,
			inspection,
			reason: `Invalid recovery resume target: ${input.target.stage}/${input.target.step}.`,
		});
	}

	const memoryReason = memoryReasonFromInspection({
		inspection,
		state: input.state,
	});
	const nextState: PlanStateRecord = {
		...input.state,
		stage: input.target.stage,
		step: input.target.step,
		stepStatus: "pending",
		nextStep: null,
		requiresCompact: false,
		requiresMemoryUpdate: memoryReason !== null,
		memoryUpdateReason: memoryReason,
		requiresUserDecision: false,
		broken: false,
		brokenReason: null,
		blockedReason:
			memoryReason !== null
				? `Recovery resumed, but memory update is required: ${memoryReason}.`
				: null,
	};

	await savePlanState(input.fs, input.planPaths, nextState);
	return {
		status: "applied",
		previousState: input.state,
		state: nextState,
		inspection,
		text: formatResumeApplied(nextState, memoryReason),
	};
}

function blockingRecoveryIssues(
	inspection: PlannerRecoveryInspection,
): PlannerRecoveryIssue[] {
	return inspection.issues.filter(
		(issue) =>
			issue.severity === "blocking" && !STATE_GATE_ISSUES.has(issue.code),
	);
}

function memoryReasonFromInspection(input: {
	inspection: PlannerRecoveryInspection;
	state: PlanStateRecord;
}): MemoryUpdateReason | null {
	if (
		input.inspection.issues.some((issue) => issue.code === "external_commit")
	) {
		return "external_commit";
	}
	if (
		input.inspection.issues.some(
			(issue) => issue.code === "memory_update_required",
		)
	) {
		return input.state.memoryUpdateReason ?? "file_hash_changed";
	}
	return null;
}

function isValidResumeTarget(target: PlannerPosition): boolean {
	try {
		return target.stage !== "recovery" && isPlannerStepInStage(target);
	} catch {
		return false;
	}
}

function formatResumeApplied(
	state: PlanStateRecord,
	memoryReason: MemoryUpdateReason | null,
): string {
	return [
		"Planner recovery resumed.",
		`Current: ${state.stage}/${state.step} (${state.stepStatus})`,
		memoryReason
			? `Memory update is still required before normal flow continues: ${memoryReason}.`
			: "No blocking recovery issue remains.",
		"Call planner_status before choosing the next planner action.",
	].join("\n");
}

function blocked(input: {
	state: PlanStateRecord;
	inspection: PlannerRecoveryInspection;
	reason: string;
}): PlannerRecoveryResumeResult {
	return {
		status: "blocked",
		state: input.state,
		inspection: input.inspection,
		reason: input.reason,
		text: [
			"Planner recovery resume blocked.",
			`Reason: ${input.reason}`,
			"Call planner_recovery_inspect and ask the user before any destructive repair.",
		].join("\n"),
	};
}
