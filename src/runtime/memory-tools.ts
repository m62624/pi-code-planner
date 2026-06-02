import type { GitRunner } from "../git/runner";
import { buildProjectMap } from "../memory/project-map";
import { searchProjectFiles } from "../memory/project-search";
import type { PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import {
	checkPlannerOrchestratorToolAllowed,
	runPlannerOrchestrator,
} from "./orchestrator";

export const PLANNER_MEMORY_TOOL_NAMES = [
	"planner_memory_project_map",
	"planner_memory_search_project",
] as const;

export const PLANNER_EXPOSED_MEMORY_TOOL_NAMES = PLANNER_MEMORY_TOOL_NAMES;

export type PlannerMemoryToolName = (typeof PLANNER_MEMORY_TOOL_NAMES)[number];

export interface PlannerMemoryToolExecutionInput {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
	toolName: PlannerMemoryToolName;
	params: unknown;
}

export interface PlannerMemoryToolExecutionResult {
	status: "applied" | "blocked";
	text: string;
	toolName: PlannerMemoryToolName;
	details: unknown;
}

export async function executePlannerMemoryTool(
	input: PlannerMemoryToolExecutionInput,
): Promise<PlannerMemoryToolExecutionResult> {
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
			policy.reason ?? `Planner memory tool ${input.toolName} is blocked.`,
		);
	}
	const worktreePath = orchestrator.preflight.context.state.worktreePath;
	if (!worktreePath) {
		return blocked(input.toolName, "Planner worktree path is missing.");
	}

	try {
		const params = asObject(input.params);
		switch (input.toolName) {
			case "planner_memory_project_map": {
				const result = await buildProjectMap({
					git: input.git,
					repoRoot: worktreePath,
					maxPathsPerGroup: optionalNumber(params.maxPathsPerGroup),
				});
				return applied(input.toolName, result);
			}
			case "planner_memory_search_project": {
				const result = await searchProjectFiles({
					fs: input.fs,
					git: input.git,
					repoRoot: worktreePath,
					query: requiredString(params.query, "query"),
					limit: optionalNumber(params.limit),
				});
				return applied(input.toolName, result);
			}
		}
	} catch (error) {
		return blocked(
			input.toolName,
			error instanceof Error ? error.message : String(error),
		);
	}
}

function applied(
	toolName: PlannerMemoryToolName,
	details: unknown,
): PlannerMemoryToolExecutionResult {
	return {
		status: "applied",
		toolName,
		text: JSON.stringify(details, null, 2),
		details,
	};
}

function blocked(
	toolName: PlannerMemoryToolName,
	reason: string,
): PlannerMemoryToolExecutionResult {
	return {
		status: "blocked",
		toolName,
		text: `Planner context retrieval blocked.\nReason: ${reason}`,
		details: { reason },
	};
}

function asObject(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: {};
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${field} must be a non-empty string.`);
	}
	return value;
}

function optionalNumber(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new TypeError("Expected a finite number.");
	}
	return value;
}
