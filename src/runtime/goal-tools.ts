import type { GitRunner } from "../git/runner";
import type { PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import { savePlanState } from "../storage/state-store";
import {
	checkPlannerOrchestratorToolAllowed,
	runPlannerOrchestrator,
} from "./orchestrator";
import {
	advancePlannerStep,
	completePlannerStep,
	startPlannerStep,
} from "./state-machine";

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

export interface PlannerGoalToolExecutionResult {
	status: "applied" | "blocked";
	toolName: PlannerGoalToolName;
	text: string;
	details: unknown;
}

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
		await input.fs.writeTextAtomic(planPaths.goalMd, `${content.trim()}\n`);
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
				content.trim(),
				"",
				"Ask the user to review the goal and explicitly approve it or request revision.",
				"After the user answers, call planner_goal_decide.",
			].join("\n"),
			{ state: next, goalMd: planPaths.goalMd },
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
	const completed = completePlannerStep(state, {
		next:
			decision === "approve"
				? { stage: "discovery", step: "scan_project_structure" }
				: { stage: "intake", step: "draft_goal" },
	});
	const next = advancePlannerStep(completed);
	const resumed = decision === "revise" ? startPlannerStep(next) : next;
	await savePlanState(input.fs, planPaths, resumed);
	return applied(
		input.toolName,
		decision === "approve"
			? "Planner goal approved. Discovery is now available. Call planner_status, then start discovery/scan_project_structure."
			: "Planner goal needs revision. Read request.md, apply the user's feedback, and call planner_goal_submit with the revised goal.md.",
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

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
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
