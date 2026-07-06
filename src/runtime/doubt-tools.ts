import { errorMessage } from "../errors";
import type { GitRunner } from "../git/runner";
import type { PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import { ARTIFACT_CANONICAL_SCHEMA, formatArtifactEcho } from "./artifact-echo";
import {
	collectVerificationProtocolErrors,
	DOUBT_FINDING_SHAPE_HINT,
	DOUBT_FINDING_STATUSES,
	DOUBT_NEXT_ACTIONS,
	DOUBT_PROOF_LEVELS,
	DOUBT_REVIEW_TOOL_NAMES,
	DOUBT_RISK_CATEGORIES,
	formatDoubtReviewMarkdown,
	type PlannerDoubtReviewToolName,
	parseDoubtReviewParams,
	validateDoubtReview,
} from "./doubt-review";
import {
	checkPlannerOrchestratorToolAllowed,
	runPlannerOrchestrator,
} from "./orchestrator";
import { blockedResult } from "./tool-result";

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
		// Gather field-level and protocol-level violations together so the model
		// sees the full set in one rejection and can fix them in a single retry,
		// instead of bouncing between one incremental error at a time.
		const validation = validateDoubtReview(review);
		const protocolErrors = collectVerificationProtocolErrors(
			review,
			await input.fs.readText(planPaths.discoveryMd),
		);
		const allErrors = [...validation.errors, ...protocolErrors];
		if (allErrors.length > 0) {
			throw new TypeError(formatDoubtReviewRejection(allErrors));
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
				"",
				formatArtifactEcho({
					canonicalSchema: ARTIFACT_CANONICAL_SCHEMA.planner_doubt_review,
					writtenMarkdown: content,
				}),
				"",
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
		return blocked(input.toolName, appendDoubtHint(errorMessage(error)));
	}
}

/**
 * Render one or many validation reasons as a single rejection body. A single
 * reason is returned verbatim; multiple reasons are numbered so the model can
 * address every one of them in the next call.
 */
function formatDoubtReviewRejection(errors: string[]): string {
	if (errors.length <= 1) {
		return errors[0] ?? "Doubt Review is invalid.";
	}
	return [
		"planner_doubt_review was rejected for the following reason(s):",
		...errors.map((reason, index) => `${index + 1}. ${reason}`),
	].join("\n\n");
}

/**
 * Append the stack-agnostic finding-shape cheat-sheet to every rejection so a
 * model always sees the complete grammar and can converge without guessing.
 */
function appendDoubtHint(message: string): string {
	return `${message}\n\n${DOUBT_FINDING_SHAPE_HINT}`;
}

function blocked(
	toolName: PlannerDoubtReviewToolName,
	text: string,
): PlannerDoubtToolExecutionResult {
	return blockedResult(toolName, text);
}
