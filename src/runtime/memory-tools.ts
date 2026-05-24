import type { GitRunner } from "../git/runner";
import {
	applyMemoryGateFreshness,
	inspectMemoryGate,
	type MemoryGateInspection,
} from "../memory/gate";
import {
	clearMemoryDirty,
	readMemoryCheckpoint,
	readMemoryDirtyState,
	writeMemoryCheckpoint,
} from "../memory/manager";
import { writeMemoryBatchWithReferences } from "../memory/write-api";
import type { PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import { savePlanState } from "../storage/state-store";
import { markMemoryCheckpointSynced } from "./git-state-sync";
import {
	checkPlannerPreflightToolAllowed,
	type PlannerPreflightResult,
	runPlannerPreflight,
} from "./preflight";

export const PLANNER_MEMORY_TOOL_NAMES = [
	"planner_memory_inspect",
	"planner_memory_apply_freshness",
	"planner_memory_write_batch",
	"planner_memory_verify",
	"planner_memory_sync_checkpoint",
] as const;

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

interface ReadyMemoryContext {
	status: "ready";
	preflight: PlannerPreflightResult & {
		context: Extract<PlannerPreflightResult["context"], { status: "ready" }>;
	};
	worktreePath: string;
	memoryPaths: NonNullable<PlannerPreflightResult["memoryPaths"]>;
}

export async function executePlannerMemoryTool(
	input: PlannerMemoryToolExecutionInput,
): Promise<PlannerMemoryToolExecutionResult> {
	const preflight = await runPlannerPreflight(input);
	const ready = readyMemoryContext(preflight, input.toolName);
	if (ready.status === "blocked") {
		return ready.result;
	}

	switch (input.toolName) {
		case "planner_memory_inspect": {
			const inspection =
				preflight.memoryGate ??
				(await inspectMemoryGate({
					fs: input.fs,
					git: input.git,
					repoRoot: ready.worktreePath,
					memoryPaths: ready.memoryPaths,
				}));
			return applied(input.toolName, formatMemoryInspection(inspection), {
				inspection,
			});
		}
		case "planner_memory_apply_freshness": {
			const inspection = await applyMemoryGateFreshness({
				fs: input.fs,
				git: input.git,
				repoRoot: ready.worktreePath,
				memoryPaths: ready.memoryPaths,
				detectedAt: nowIso(input.params),
			});
			await refreshMemoryCheckpointHashes(input.fs, ready.memoryPaths);
			return applied(input.toolName, formatMemoryInspection(inspection), {
				inspection,
			});
		}
		case "planner_memory_write_batch": {
			const params = asObject(input.params);
			const result = await writeMemoryBatchWithReferences({
				fs: input.fs,
				paths: ready.memoryPaths,
				files: arrayOrUndefined(params.files),
				symbols: arrayOrUndefined(params.symbols),
				relations: arrayOrUndefined(params.relations),
			});
			await refreshMemoryCheckpointHashes(input.fs, ready.memoryPaths);
			return applied(
				input.toolName,
				[
					"Planner memory batch written.",
					`Accepted: ${result.totals.accepted}.`,
					`Rejected: ${result.totals.rejected}.`,
					"Call planner_memory_verify before syncing the memory checkpoint.",
				].join("\n"),
				{ result },
			);
		}
		case "planner_memory_verify": {
			const inspection = await inspectMemoryGate({
				fs: input.fs,
				git: input.git,
				repoRoot: ready.worktreePath,
				memoryPaths: ready.memoryPaths,
			});
			return applied(
				input.toolName,
				inspection.clean
					? "Planner memory is fresh. Call planner_memory_sync_checkpoint to clear the memory gate."
					: formatMemoryInspection(inspection),
				{ inspection },
			);
		}
		case "planner_memory_sync_checkpoint": {
			const inspection = await inspectMemoryGate({
				fs: input.fs,
				git: input.git,
				repoRoot: ready.worktreePath,
				memoryPaths: ready.memoryPaths,
			});
			if (!inspection.clean) {
				return blocked(
					input.toolName,
					"Memory is still stale. Update file, symbol, relation, and effects entries before syncing checkpoint.",
					{ inspection },
				);
			}
			const head = preflight.gitReality?.headCommit;
			if (!head) {
				return blocked(input.toolName, "Git HEAD is unavailable.", {
					preflight,
				});
			}
			await writeMemoryCheckpoint(input.fs, ready.memoryPaths, head);
			const dirty = await readMemoryDirtyState(input.fs, ready.memoryPaths);
			await clearMemoryDirty(
				input.fs,
				ready.memoryPaths,
				Object.keys(dirty.files),
			);
			const state = markMemoryCheckpointSynced({
				state: ready.preflight.context.state,
				headCommit: head,
			});
			await savePlanState(input.fs, ready.preflight.context.planPaths, state);
			return applied(
				input.toolName,
				"Planner memory checkpoint synced. Normal planner flow may continue.",
				{ checkpointCommit: head, state },
			);
		}
	}
}

function readyMemoryContext(
	preflight: PlannerPreflightResult,
	toolName: PlannerMemoryToolName,
):
	| ReadyMemoryContext
	| {
			status: "blocked";
			result: PlannerMemoryToolExecutionResult;
	  } {
	if (preflight.context.status !== "ready") {
		return {
			status: "blocked",
			result: blocked(toolName, preflight.context.reason, { preflight }),
		};
	}
	const policy = checkPlannerPreflightToolAllowed({
		preflight,
		tool: toolName,
	});
	if (!policy.allow) {
		return {
			status: "blocked",
			result: blocked(
				toolName,
				policy.reason ?? `Planner memory tool ${toolName} is blocked.`,
				{ preflight, policy },
			),
		};
	}
	if (!preflight.context.state.worktreePath || !preflight.memoryPaths) {
		return {
			status: "blocked",
			result: blocked(
				toolName,
				"Planner worktree or memory paths are missing.",
				{
					preflight,
				},
			),
		};
	}
	return {
		status: "ready",
		preflight: preflight as ReadyMemoryContext["preflight"],
		worktreePath: preflight.context.state.worktreePath,
		memoryPaths: preflight.memoryPaths,
	};
}

async function refreshMemoryCheckpointHashes(
	fs: PlannerFs,
	memoryPaths: NonNullable<PlannerPreflightResult["memoryPaths"]>,
): Promise<void> {
	const checkpoint = await readMemoryCheckpoint(fs, memoryPaths);
	await writeMemoryCheckpoint(fs, memoryPaths, checkpoint.commit);
}

function formatMemoryInspection(inspection: MemoryGateInspection): string {
	return [
		inspection.clean
			? "Planner memory matches the current project snapshot."
			: "Planner memory is stale.",
		`Files to reindex: ${inspection.freshness.filesToReindex.join(", ") || "(none)"}.`,
		`Affected symbols: ${inspection.freshness.affectedSymbolIds.join(", ") || "(none)"}.`,
		`Affected relations: ${inspection.freshness.affectedRelationIds.join(", ") || "(none)"}.`,
		`Required checks: ${inspection.requiredChecks.join(", ") || "(none)"}.`,
	].join("\n");
}

function applied(
	toolName: PlannerMemoryToolName,
	text: string,
	details: unknown,
): PlannerMemoryToolExecutionResult {
	return { status: "applied", toolName, text, details };
}

function blocked(
	toolName: PlannerMemoryToolName,
	text: string,
	details: unknown,
): PlannerMemoryToolExecutionResult {
	return { status: "blocked", toolName, text, details };
}

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function arrayOrUndefined(value: unknown): readonly unknown[] | undefined {
	return Array.isArray(value) ? value : undefined;
}

function nowIso(params: unknown): string {
	const detectedAt = asObject(params).detectedAt;
	return typeof detectedAt === "string" && detectedAt.trim().length > 0
		? detectedAt
		: new Date().toISOString();
}
