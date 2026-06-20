import type { GitRunner } from "../git/runner";
import type { PlannerWrapperTool } from "../guard/tool-policy";
import type { PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import { savePlanState } from "../storage/state-store";
import {
	ARTIFACT_CANONICAL_SCHEMA,
	formatCanonicalSchemaHint,
} from "./artifact-echo";
import {
	checkPlannerOrchestratorToolAllowed,
	runPlannerOrchestrator,
} from "./orchestrator";

export const PLANNER_QUESTION_TOOL_NAMES = [
	"planner_questions_submit",
	"planner_questions_resolve",
] as const satisfies readonly PlannerWrapperTool[];

export type PlannerQuestionToolName =
	(typeof PLANNER_QUESTION_TOOL_NAMES)[number];

export interface PlannerQuestionToolExecutionInput {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
	toolName: PlannerQuestionToolName;
	params: unknown;
}

export interface PlannerQuestionToolExecutionResult {
	status: "applied" | "blocked";
	toolName: PlannerQuestionToolName;
	text: string;
	details: unknown;
}

export async function executePlannerQuestionTool(
	input: PlannerQuestionToolExecutionInput,
): Promise<PlannerQuestionToolExecutionResult> {
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
			policy.reason ?? `Planner question tool ${input.toolName} is blocked.`,
			{ orchestrator, policy },
		);
	}

	const { planPaths, state } = orchestrator.preflight.context;
	const params = asObject(input.params);
	if (input.toolName === "planner_questions_submit") {
		if (state.questionsSubmitted) {
			return blocked(
				input.toolName,
				"Discovery questions were already submitted. Use planner_questions_resolve when answers are still required, or planner_finish_step when no questions remain.",
				{ orchestrator },
			);
		}
		const content = optionalString(params, "content");
		if (content === undefined) {
			return blocked(
				input.toolName,
				"planner_questions_submit needs `content`: the full questions.md markdown (a non-empty string).",
				{ orchestrator },
			);
		}
		const hasOpenQuestions = optionalBoolean(params, "hasOpenQuestions");
		if (hasOpenQuestions === undefined) {
			return blocked(
				input.toolName,
				"planner_questions_submit needs `hasOpenQuestions` (boolean): true when the user must answer before discovery continues, false for an explicit no-questions artifact.",
				{ orchestrator },
			);
		}
		await input.fs.writeTextAtomic(
			planPaths.questionsMd,
			`${content.trim()}\n`,
		);
		const next = {
			...state,
			questionsSubmitted: true,
			questionsResolved: !hasOpenQuestions,
		};
		await savePlanState(input.fs, planPaths, next);
		return applied(
			input.toolName,
			[
				"Planner discovery questions saved.",
				`Questions artifact: ${planPaths.questionsMd}`,
				"",
				"## Questions For User",
				content.trim(),
				"",
				formatCanonicalSchemaHint(
					ARTIFACT_CANONICAL_SCHEMA.planner_questions_submit,
				),
				"",
				hasOpenQuestions
					? "Show these questions to the user verbatim. Wait for the user's answers, then call planner_questions_resolve. Do not finish discovery/write_questions yet."
					: "No unresolved questions remain. Call planner_finish_step for discovery/write_questions.",
			].join("\n"),
			{ state: next, questionsMd: planPaths.questionsMd, hasOpenQuestions },
		);
	}

	if (!state.questionsSubmitted) {
		return blocked(
			input.toolName,
			"Submit discovery questions before resolving them. Call planner_questions_submit first.",
			{ orchestrator },
		);
	}
	if (state.questionsResolved) {
		return blocked(
			input.toolName,
			"Discovery questions are already resolved. Call planner_finish_step for discovery/write_questions.",
			{ orchestrator },
		);
	}
	const answers = optionalString(params, "answers");
	if (answers === undefined) {
		return blocked(
			input.toolName,
			"planner_questions_resolve needs `answers`: the user's answers in durable markdown form (a non-empty string).",
			{ orchestrator },
		);
	}
	await appendText(
		input.fs,
		planPaths.decisionsMd,
		`## Discovery Question Answers\n\n${answers.trim()}`,
	);
	await appendText(
		input.fs,
		planPaths.questionsMd,
		`## User Answers\n\n${answers.trim()}\n\n## Resolution\n\nDiscovery questions were answered explicitly. The same durable answers were recorded in decisions.md.`,
	);
	const next = { ...state, questionsSubmitted: true, questionsResolved: true };
	await savePlanState(input.fs, planPaths, next);
	return applied(
		input.toolName,
		[
			"Planner discovery question answers saved.",
			`Decisions artifact: ${planPaths.decisionsMd}`,
			"Call planner_finish_step for discovery/write_questions.",
		].join("\n"),
		{ state: next, decisionsMd: planPaths.decisionsMd },
	);
}

async function appendText(
	fs: PlannerFs,
	path: string,
	content: string,
): Promise<void> {
	const current = (await fs.exists(path)) ? await fs.readText(path) : "";
	await fs.writeTextAtomic(
		path,
		`${current.trimEnd()}${current.trim().length > 0 ? "\n\n" : ""}${content.trim()}\n`,
	);
}

function optionalString(
	params: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = params[key];
	return typeof value === "string" && value.trim().length > 0
		? value
		: undefined;
}

function optionalBoolean(
	params: Record<string, unknown>,
	key: string,
): boolean | undefined {
	const value = params[key];
	return typeof value === "boolean" ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function applied(
	toolName: PlannerQuestionToolName,
	text: string,
	details: unknown,
): PlannerQuestionToolExecutionResult {
	return { status: "applied", toolName, text, details };
}

function blocked(
	toolName: PlannerQuestionToolName,
	text: string,
	details: unknown,
): PlannerQuestionToolExecutionResult {
	return { status: "blocked", toolName, text, details };
}
