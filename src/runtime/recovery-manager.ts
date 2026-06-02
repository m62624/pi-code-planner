import type { GitRunner } from "../git/runner";
import type { PlannerFs } from "../storage/fs";
import type { PlanStoragePaths, ProjectStoragePaths } from "../storage/paths";
import type { PlanStateRecord } from "../storage/schema";
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
		text: formatResumeApplied(nextState),
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

function isValidResumeTarget(target: PlannerPosition): boolean {
	try {
		return target.stage !== "recovery" && isPlannerStepInStage(target);
	} catch {
		return false;
	}
}

function formatResumeApplied(state: PlanStateRecord): string {
	return [
		"Planner recovery resumed.",
		`Current: ${state.stage}/${state.step} (${state.stepStatus})`,
		"No blocking recovery issue remains.",
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
