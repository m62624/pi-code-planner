import type { GitRunner } from "../git/runner";
import type { PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import {
	DOUBT_FINDING_STATUSES,
	DOUBT_NEXT_ACTIONS,
	DOUBT_PROOF_LEVELS,
	DOUBT_REVIEW_TOOL_NAMES,
	DOUBT_RISK_CATEGORIES,
	formatDoubtReviewMarkdown,
	type PlannerDoubtReviewToolName,
	parseDoubtReviewParams,
	validateDoubtReview,
	validateDoubtReviewAgainstVerificationProtocol,
} from "./doubt-review";
import {
	checkPlannerOrchestratorToolAllowed,
	runPlannerOrchestrator,
} from "./orchestrator";

export {
	DOUBT_FINDING_STATUSES,
	DOUBT_NEXT_ACTIONS,
	DOUBT_PROOF_LEVELS,
	DOUBT_REVIEW_TOOL_NAMES,
	DOUBT_RISK_CATEGORIES,
	type PlannerDoubtReviewToolName,
};

export interface PlannerDoubtToolExecutionResult {
	status: "applied" | "blocked";
	toolName: PlannerDoubtReviewToolName;
	text: string;
	details: {
		verifyMd: string;
		provenBugCount: number;
		needsProbeCount: number;
	} | null;
}

export async function executePlannerDoubtTool(input: {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
	toolName: PlannerDoubtReviewToolName;
	params: unknown;
}): Promise<PlannerDoubtToolExecutionResult> {
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
			policy.reason ?? `Planner doubt tool ${input.toolName} is blocked.`,
		);
	}

	const { state, planPaths } = orchestrator.preflight.context;
	if (
		state.stage !== "finalize" ||
		state.step !== "doubt_review" ||
		state.stepStatus !== "running"
	) {
		return blocked(
			input.toolName,
			"planner_doubt_review is allowed only while finalize/doubt_review is running.",
		);
	}

	try {
		const review = parseDoubtReviewParams(input.params);
		const validation = validateDoubtReview(review);
		if (!validation.valid) {
			throw new TypeError(validation.reason ?? "Doubt Review is invalid.");
		}
		const protocolValidation = validateDoubtReviewAgainstVerificationProtocol(
			review,
			await input.fs.readText(planPaths.discoveryMd),
		);
		if (protocolValidation) {
			throw new TypeError(protocolValidation);
		}
		const content = formatDoubtReviewMarkdown(review);
		await input.fs.writeTextAtomic(planPaths.verifyMd, content);
		return {
			status: "applied",
			toolName: input.toolName,
			text: [
				"Planner doubt review written.",
				`Verify artifact: ${planPaths.verifyMd}`,
				`Proven bugs: ${validation.provenBugCount}`,
				`Needs probe: ${validation.needsProbeCount}`,
				validation.provenBugCount > 0
					? "Complete finalize/doubt_review with target planning/read_context after recording the proven findings in decisions.md."
					: validation.needsProbeCount > 0
						? "Run the listed probes before calling a finding a real bug, or record why they are not actionable."
						: "No proven bug remains. Continue toward write_final_summary.",
				"Call planner_status before choosing the next planner action.",
			].join("\n"),
			details: {
				verifyMd: planPaths.verifyMd,
				provenBugCount: validation.provenBugCount,
				needsProbeCount: validation.needsProbeCount,
			},
		};
	} catch (error) {
		return blocked(input.toolName, errorMessage(error));
	}
}

function blocked(
	toolName: PlannerDoubtReviewToolName,
	text: string,
): PlannerDoubtToolExecutionResult {
	return { status: "blocked", toolName, text, details: null };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
