import { join } from "node:path";
import { errorMessage } from "../errors";
import type { GitRunner } from "../git/runner";
import type { PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import { ARTIFACT_CANONICAL_SCHEMA, formatArtifactEcho } from "./artifact-echo";
import {
	checkPlannerOrchestratorToolAllowed,
	runPlannerOrchestrator,
} from "./orchestrator";
import { requiredString } from "./params";
import {
	formatRefactorReviewMarkdown,
	REFACTOR_REVIEW_CATEGORIES,
	REFACTOR_REVIEW_CATEGORY_STATUSES,
	type RefactorCategoryReview,
	type RefactorDecision,
	type RefactorReviewCategory,
	type RefactorReviewCategoryStatus,
	validateRefactorCategoryReviews,
	validateRefactorReviewMarkdown,
} from "./refactor-review";
import { asObject } from "./values";

export const PLANNER_REFACTOR_TOOL_NAMES = ["planner_refactor_review"] as const;
export type PlannerRefactorToolName =
	(typeof PLANNER_REFACTOR_TOOL_NAMES)[number];

export { REFACTOR_REVIEW_CATEGORIES, REFACTOR_REVIEW_CATEGORY_STATUSES };

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
		const categoryReviews = parseCategoryReviews(params.categoryReviews);
		const categoryValidation = validateRefactorCategoryReviews(categoryReviews);
		if (!categoryValidation.valid) {
			throw new TypeError(
				categoryValidation.reason ?? "category review is invalid.",
			);
		}
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
			categoryReviews,
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
				"",
				formatArtifactEcho({
					canonicalSchema: ARTIFACT_CANONICAL_SCHEMA.planner_refactor_review,
					writtenMarkdown: content,
				}),
				"",
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

function parseCategoryReviews(value: unknown): RefactorCategoryReview[] {
	if (!Array.isArray(value)) {
		throw new TypeError("categoryReviews must be an array.");
	}
	return value.map((entry) => {
		const object = asObject(entry);
		return {
			category: requiredCategory(object),
			status: requiredCategoryStatus(object),
			evidence: requiredString(object, "evidence"),
			action: requiredString(object, "action"),
		};
	});
}

function requiredCategory(
	params: Record<string, unknown>,
): RefactorReviewCategory {
	const value = params.category;
	if (!REFACTOR_REVIEW_CATEGORIES.includes(value as RefactorReviewCategory)) {
		throw new TypeError(
			`category must be one of: ${REFACTOR_REVIEW_CATEGORIES.join(", ")}.`,
		);
	}
	return value as RefactorReviewCategory;
}

function requiredCategoryStatus(
	params: Record<string, unknown>,
): RefactorReviewCategoryStatus {
	const value = params.status;
	if (
		!REFACTOR_REVIEW_CATEGORY_STATUSES.includes(
			value as RefactorReviewCategoryStatus,
		)
	) {
		throw new TypeError(
			`status must be one of: ${REFACTOR_REVIEW_CATEGORY_STATUSES.join(", ")}.`,
		);
	}
	return value as RefactorReviewCategoryStatus;
}
