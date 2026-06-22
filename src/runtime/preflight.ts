import type { GitRunner } from "../git/runner";
import type { PlannerWrapperTool } from "../guard/tool-policy";
import { createInstructionPaths } from "../instructions/paths";
import {
	getInstructionRoutingForState,
	type InstructionRouting,
} from "../instructions/routing";
import type { PlanStoragePaths } from "../storage/paths";
import { type ActivePlanContext, readActivePlanContext } from "./active-plan";
import {
	inspectPlannerGitReality,
	type PlannerGitReality,
} from "./git-state-sync";
import {
	evaluatePlannerRuntimeReality,
	type PlannerRuntimeDecision,
} from "./planner-runtime";
import { getAllowedPlannerStateTransitionTypes } from "./state-transition";
import type { PlannerToolContext } from "./tool-context";

export type PlannerPreflightInput = PlannerToolContext;

export interface PlannerPreflightResult {
	context: ActivePlanContext;
	decision: PlannerRuntimeDecision;
	planPaths: PlanStoragePaths | null;
	gitReality: PlannerGitReality | null;
	instructions: InstructionRouting | null;
	worktreeExists: boolean | null;
}

export interface PlannerPreflightToolDecision {
	allow: boolean;
	tool: PlannerWrapperTool;
	runtimeAction: PlannerRuntimeDecision["action"];
	reason: string | null;
	allowedTools: readonly PlannerWrapperTool[];
}

export async function runPlannerPreflight(
	input: PlannerPreflightInput,
): Promise<PlannerPreflightResult> {
	const context = await readActivePlanContext({
		fs: input.fs,
		projectPaths: input.projectPaths,
	});

	if (context.status !== "ready") {
		return {
			context,
			decision: evaluatePlannerRuntimeReality({
				contextStatus: context.status,
			}),
			planPaths: null,
			gitReality: null,
			instructions: null,
			worktreeExists: null,
		};
	}

	const instructions = getInstructionRoutingForState({
		state: context.state,
		paths: createInstructionPaths(input.projectPaths),
	});
	const worktreeExists = context.state.worktreePath
		? await input.fs.exists(context.state.worktreePath)
		: false;

	if (!context.state.worktreePath || !worktreeExists) {
		return {
			context,
			decision: evaluatePlannerRuntimeReality({
				contextStatus: context.status,
				state: context.state,
				worktreeExists,
			}),
			planPaths: context.planPaths,
			gitReality: null,
			instructions,
			worktreeExists,
		};
	}

	const gitReality = await safeInspectGitReality({
		git: input.git,
		repoRoot: context.state.worktreePath,
	});

	if (!gitReality || hasImmediateGitRecovery(context.state, gitReality)) {
		return {
			context,
			decision: evaluatePlannerRuntimeReality({
				contextStatus: context.status,
				state: context.state,
				git: gitReality,
				worktreeExists,
			}),
			planPaths: context.planPaths,
			gitReality,
			instructions,
			worktreeExists,
		};
	}

	const decision = evaluatePlannerRuntimeReality({
		contextStatus: context.status,
		state: context.state,
		git: gitReality,
		worktreeExists,
	});

	return {
		context,
		decision,
		planPaths: context.planPaths,
		gitReality,
		instructions,
		worktreeExists,
	};
}

export function checkPlannerPreflightToolAllowed(input: {
	preflight: PlannerPreflightResult;
	tool: PlannerWrapperTool;
}): PlannerPreflightToolDecision {
	const allowedTools = input.preflight.decision.allowedTools;
	const allow = allowedTools.includes(input.tool);
	return {
		allow,
		tool: input.tool,
		runtimeAction: input.preflight.decision.action,
		reason: allow
			? null
			: [
					`Planner wrapper ${input.tool} is blocked by runtime preflight.`,
					`Runtime action: ${input.preflight.decision.action}.`,
					input.preflight.decision.reason,
					`Extension tools (this planner session only): ${allowedTools.join(", ") || "(none)"}.`,
				]
					.filter(Boolean)
					.join("\n"),
		allowedTools,
	};
}

export function formatPlannerPreflightStatus(
	preflight: PlannerPreflightResult,
): string {
	const lines = [
		"Planner status.",
		`Runtime action: ${preflight.decision.action}`,
	];
	if (preflight.decision.reason) {
		lines.push(`Reason: ${preflight.decision.reason}`);
	}
	if (preflight.context.status === "ready") {
		lines.push(
			`Stage/step: ${preflight.decision.stage}/${preflight.decision.step}`,
		);
		if (preflight.decision.nextStep) {
			lines.push(`Next step: ${preflight.decision.nextStep}`);
		}
		lines.push(`Active plan: ${preflight.context.activePlanId}`);
		if (preflight.context.state.worktreePath) {
			lines.push(`Worktree: ${preflight.context.state.worktreePath}`);
		}
		if (preflight.gitReality) {
			lines.push(
				`Git: ${preflight.gitReality.branch} @ ${preflight.gitReality.headCommit}`,
			);
		}
		if (preflight.instructions) {
			lines.push(
				`Instruction keys: ${preflight.instructions.keys.join(", ") || "(none)"}`,
			);
			lines.push("Instruction files:");
			for (const entry of preflight.instructions.entries) {
				lines.push(`- ${entry.key}`);
				lines.push(`  default: ${entry.defaultPath}`);
				lines.push(`  project append: ${entry.projectAppendPath}`);
				lines.push(`  global append: ${entry.globalAppendPath}`);
			}
		}
	} else {
		lines.push(`Context status: ${preflight.context.status}`);
		lines.push(preflight.context.reason);
	}
	lines.push(
		`Extension tools (this planner session only): ${preflight.decision.allowedTools.join(", ") || "(none)"}`,
	);
	lines.push(
		`Allowed state transitions: ${getAllowedPlannerStateTransitionTypes(preflight).join(", ") || "(none)"}`,
	);
	lines.push("Read the listed markdown instruction files before continuing.");
	lines.push("Do not use raw git while a planner plan is active.");
	return lines.join("\n");
}

async function safeInspectGitReality(input: {
	git: GitRunner;
	repoRoot: string;
}): Promise<PlannerGitReality | null> {
	try {
		return await inspectPlannerGitReality(input);
	} catch {
		return null;
	}
}

function hasImmediateGitRecovery(
	state: { currentBranch: string | null },
	reality: PlannerGitReality,
): boolean {
	return (
		reality.hasConflicts ||
		(state.currentBranch !== null && reality.branch !== state.currentBranch)
	);
}
