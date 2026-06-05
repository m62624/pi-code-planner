import { join } from "node:path";
import type { GitRunner } from "../git/runner";
import type { PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import {
	checkPlannerOrchestratorToolAllowed,
	runPlannerOrchestrator,
} from "./orchestrator";
import {
	formatRefactorReviewMarkdown,
	type RefactorDecision,
	validateRefactorReviewMarkdown,
} from "./refactor-review";

export const PLANNER_REFACTOR_TOOL_NAMES = ["planner_refactor_review"] as const;
export type PlannerRefactorToolName =
	(typeof PLANNER_REFACTOR_TOOL_NAMES)[number];

export interface PlannerRefactorToolExecutionResult {
	status: "applied" | "blocked";
	toolName: PlannerRefactorToolName;
	text: string;
	details: { refactorMd: string; decision: RefactorDecision } | null;
}

export async function executePlannerRefactorTool(input: {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
	toolName: PlannerRefactorToolName;
	params: unknown;
}): Promise<PlannerRefactorToolExecutionResult> {
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
			policy.reason ?? `Planner refactor tool ${input.toolName} is blocked.`,
		);
	}

	const { state, planPaths } = orchestrator.preflight.context;
	if (
		state.stage !== "execution" ||
		state.step !== "refactor_task" ||
		state.stepStatus !== "running"
	) {
		return blocked(
			input.toolName,
			"planner_refactor_review is allowed only while execution/refactor_task is running.",
		);
	}
	if (!state.activeTaskId) {
		return blocked(
			input.toolName,
			"planner_refactor_review requires an active task id.",
		);
	}

	try {
		const params = asObject(input.params);
		const decision = requiredDecision(params);
		const changesApplied = optionalString(params, "changesApplied");
		const whyKept = optionalString(params, "whyKept");
		if (decision === "changed" && !changesApplied) {
			throw new TypeError(
				"changesApplied must be a non-empty string when decision is changed.",
			);
		}
		if (decision === "kept" && !whyKept) {
			throw new TypeError(
				"whyKept must be a non-empty string when decision is kept.",
			);
		}

		const refactorMd = join(
			planPaths.tasksDir,
			state.activeTaskId,
			"refactor.md",
		);
		const content = formatRefactorReviewMarkdown({
			changedSurface: requiredString(params, "changedSurface"),
			complexity: requiredString(params, "complexity"),
			duplication: requiredString(params, "duplication"),
			namingAndBoundaries: requiredString(params, "namingAndBoundaries"),
			edgeCases: requiredString(params, "edgeCases"),
			decision,
			changesApplied,
			whyKept,
		});
		const validation = validateRefactorReviewMarkdown(content);
		if (!validation.valid) {
			throw new TypeError(validation.reason ?? "refactor review is invalid.");
		}

		await input.fs.writeTextAtomic(refactorMd, content);
		return {
			status: "applied",
			toolName: input.toolName,
			text: [
				"Planner refactor review written.",
				`Refactor artifact: ${refactorMd}`,
				`Decision: ${decision}`,
				"If project files changed during refactor, commit through planner_git_commit before finishing.",
				"Then call planner_status before choosing the next planner action.",
			].join("\n"),
			details: { refactorMd, decision },
		};
	} catch (error) {
		return blocked(input.toolName, errorMessage(error));
	}
}

function blocked(
	toolName: PlannerRefactorToolName,
	text: string,
): PlannerRefactorToolExecutionResult {
	return { status: "blocked", toolName, text, details: null };
}

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function requiredString(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${key} must be a non-empty string.`);
	}
	return value.trim();
}

function optionalString(
	params: Record<string, unknown>,
	key: string,
): string | null {
	const value = params[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

function requiredDecision(params: Record<string, unknown>): RefactorDecision {
	const value = params.decision;
	if (value !== "changed" && value !== "kept") {
		throw new TypeError("decision must be changed or kept.");
	}
	return value;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
