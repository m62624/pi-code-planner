import type { GitRunner } from "../git/runner";
import type { PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import { updatePlanRecord } from "../storage/plan-store";
import { upsertProjectPlanSummary } from "../storage/project-store";
import { savePlanState } from "../storage/state-store";
import {
	ARTIFACT_CANONICAL_SCHEMA,
	formatCanonicalSchemaHint,
} from "./artifact-echo";
import {
	checkPlannerOrchestratorToolAllowed,
	runPlannerOrchestrator,
} from "./orchestrator";
import {
	validatePlannerPlanDescription,
	validatePlannerPlanTitle,
} from "./plan-naming";
import {
	advancePlannerStep,
	completePlannerStep,
	startPlannerStep,
} from "./state-machine";
import type { PlannerToolResult } from "./tool-result";
import { asObject } from "./values";

export const PLANNER_GOAL_TOOL_NAMES = [
	"planner_goal_submit",
	"planner_goal_decide",
] as const;

export type PlannerGoalToolName = (typeof PLANNER_GOAL_TOOL_NAMES)[number];

export interface PlannerGoalToolExecutionInput {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
	toolName: PlannerGoalToolName;
	params: unknown;
}

export type PlannerGoalToolExecutionResult =
	PlannerToolResult<PlannerGoalToolName>;

export async function executePlannerGoalTool(
	input: PlannerGoalToolExecutionInput,
): Promise<PlannerGoalToolExecutionResult> {
	const orchestrator = await runPlannerOrchestrator(input);
	if (orchestrator.preflight.context.status !== "ready") {
		return blocked(input.toolName, orchestrator.preflight.context.reason, {
			orchestrator,
		});
	}
	const policy = checkPlannerOrchestratorToolAllowed({
		orchestrator,
		toolName: input.toolName,
	});
	if (!policy.allow) {
		return blocked(
			input.toolName,
			policy.reason ?? `Planner goal tool ${input.toolName} is blocked.`,
			{ orchestrator, policy },
		);
	}

	const { planPaths, state } = orchestrator.preflight.context;
	const params = asObject(input.params);
	if (input.toolName === "planner_goal_submit") {
		const content = requiredString(params, "content");
		const title = validatePlannerPlanTitle(requiredString(params, "title"));
		const description = validatePlannerPlanDescription(
			requiredString(params, "description"),
		);
		await input.fs.writeTextAtomic(planPaths.goalMd, `${content.trim()}\n`);
		const plan = await updatePlanRecord(input.fs, planPaths, (record) => ({
			...record,
			title,
			description,
		}));
		await upsertProjectPlanSummary(input.fs, input.projectPaths, {
			planId: plan.planId,
			title,
			description,
			status: plan.status === "draft" ? "active" : plan.status,
		});
		const next = startPlannerStep(
			advancePlannerStep(completePlannerStep(state)),
		);
		await savePlanState(input.fs, planPaths, next);
		return applied(
			input.toolName,
			[
				"Planner goal draft saved.",
				`Goal artifact: ${planPaths.goalMd}`,
				"",
				"## Goal Draft For User Review",
				`Proposed plan title: ${title}`,
				`Planner list description: ${description}`,
				"",
				content.trim(),
				"",
				formatCanonicalSchemaHint(
					ARTIFACT_CANONICAL_SCHEMA.planner_goal_submit,
				),
				"",
				"Ask the user to review the goal and explicitly approve it or request revision.",
				"After the user answers, call planner_goal_decide.",
			].join("\n"),
			{ state: next, goalMd: planPaths.goalMd, title, description },
		);
	}

	const decision = requiredDecision(params);
	const feedback = optionalString(params, "feedback");
	await appendDecision(
		input.fs,
		planPaths.decisionsMd,
		decision === "approve"
			? "Goal approved by user."
			: `Goal revision requested by user.${feedback ? ` Feedback: ${feedback}` : ""}`,
	);
	// In the discovery-first improve flow, discovery already ran before the
	// goal was drafted, so approval must continue into planning. The normal
	// create flow drafts the goal first and only then enters discovery.
	const improve = state.creationMethod === "improve";
	const approveNext = improve
		? { stage: "planning" as const, step: "read_context" as const }
		: { stage: "discovery" as const, step: "scan_project_structure" as const };
	const completed = completePlannerStep(state, {
		next:
			decision === "approve"
				? approveNext
				: { stage: "intake", step: "draft_goal" },
	});
	const next = advancePlannerStep(completed);
	const resumed = decision === "revise" ? startPlannerStep(next) : next;
	await savePlanState(input.fs, planPaths, resumed);
	const approveMessage = improve
		? "Planner goal approved. Discovery already ran for this improve plan — planning is now available. Call planner_status, then continue planning/read_context."
		: "Planner goal approved. Discovery is now available. Call planner_status, then start discovery/scan_project_structure.";
	return applied(
		input.toolName,
		decision === "approve"
			? approveMessage
			: 'Planner goal needs revision. Read request.md via planner_artifact_read (artifact: "request"), apply the user\'s feedback, and call planner_goal_submit with the revised goal.md.',
		{ decision, feedback, state: resumed },
	);
}

async function appendDecision(
	fs: PlannerFs,
	path: string,
	line: string,
): Promise<void> {
	const current = (await fs.exists(path)) ? await fs.readText(path) : "";
	await fs.writeTextAtomic(
		path,
		`${current.trimEnd()}${current ? "\n" : ""}- ${line}\n`,
	);
}

function requiredDecision(
	params: Record<string, unknown>,
): "approve" | "revise" {
	const decision = params.decision;
	if (decision !== "approve" && decision !== "revise") {
		throw new TypeError("decision must be approve or revise.");
	}
	return decision;
}

function requiredString(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${key} must be a non-empty string.`);
	}
	return value;
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

function applied(
	toolName: PlannerGoalToolName,
	text: string,
	details: unknown,
): PlannerGoalToolExecutionResult {
	return { status: "applied", toolName, text, details };
}

function blocked(
	toolName: PlannerGoalToolName,
	text: string,
	details: unknown,
): PlannerGoalToolExecutionResult {
	return { status: "blocked", toolName, text, details };
}
