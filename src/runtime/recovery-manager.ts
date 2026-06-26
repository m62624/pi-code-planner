import type { PlanStoragePaths } from "../storage/paths";
import type { PlanStateRecord } from "../storage/schema";
import { savePlanState } from "../storage/state-store";
import {
	inspectPlannerRecovery,
	type PlannerRecoveryInspection,
	type PlannerRecoveryIssue,
	repairWrongBranchIfSafe,
	type WrongBranchRepairResult,
} from "./recovery";
import { isPlannerStepInStage, type PlannerPosition } from "./state-machine";
import type { PlannerToolContext } from "./tool-context";

export interface PlannerRecoveryResumeInput extends PlannerToolContext {
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
	// Attempt the one safe self-heal first: if a failed git mutation left the
	// worktree on a different branch than state expects, realign it. Otherwise
	// wrong_branch would block the resume forever, with no planner tool able to
	// switch branches (raw git is forbidden while active). Then inspect, so a
	// repaired branch no longer shows up as a blocking issue.
	const repair = await repairWrongBranchIfSafe({
		git: input.git,
		state: input.state,
	});
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
			repair,
		});
	}
	if (input.state.stage !== "recovery") {
		return blocked({
			state: input.state,
			inspection,
			reason:
				"Planner recovery resume is allowed only when state.stage is recovery.",
			repair,
		});
	}
	if (input.target.stage === "recovery") {
		return blocked({
			state: input.state,
			inspection,
			reason: "Planner recovery cannot resume back into recovery.",
			repair,
		});
	}
	if (!isValidResumeTarget(input.target)) {
		return blocked({
			state: input.state,
			inspection,
			reason: `Invalid recovery resume target: ${input.target.stage}/${input.target.step}.`,
			repair,
		});
	}

	const nextState: PlanStateRecord = {
		...input.state,
		stage: input.target.stage,
		step: input.target.step,
		stepStatus: "pending",
		nextStep: null,
		requiresCompact: false,
		requiresUserDecision: false,
		broken: false,
		brokenReason: null,
		blockedReason: null,
	};

	await savePlanState(input.fs, input.planPaths, nextState);
	return {
		status: "applied",
		previousState: input.state,
		state: nextState,
		inspection,
		text: formatResumeApplied(nextState, repair),
	};
}

function formatRepairNote(repair: WrongBranchRepairResult): string | null {
	return repair.repaired
		? `Repaired wrong_branch: realigned the worktree from ${repair.from} back to the expected branch ${repair.to}.`
		: null;
}

function blockingRecoveryIssues(
	inspection: PlannerRecoveryInspection,
): PlannerRecoveryIssue[] {
	return inspection.issues.filter(
		(issue) =>
			issue.severity === "blocking" && !STATE_GATE_ISSUES.has(issue.code),
	);
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
	repair: WrongBranchRepairResult,
): string {
	return [
		"Planner recovery resumed.",
		formatRepairNote(repair),
		`Current: ${state.stage}/${state.step} (${state.stepStatus})`,
		"No blocking recovery issue remains.",
		"Call planner_status before choosing the next planner action.",
	]
		.filter((line): line is string => line !== null)
		.join("\n");
}

function blocked(input: {
	state: PlanStateRecord;
	inspection: PlannerRecoveryInspection;
	reason: string;
	repair?: WrongBranchRepairResult;
}): PlannerRecoveryResumeResult {
	const repairNote = input.repair ? formatRepairNote(input.repair) : null;
	return {
		status: "blocked",
		state: input.state,
		inspection: input.inspection,
		reason: input.reason,
		text: [
			"Planner recovery resume blocked.",
			repairNote,
			`Reason: ${input.reason}`,
			"Call planner_recovery_inspect and ask the user before any destructive repair.",
		]
			.filter((line): line is string => line !== null)
			.join("\n"),
	};
}
