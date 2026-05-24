import type { GitRunner } from "../git/runner";
import type { PlannerFs } from "../storage/fs";
import type { MemoryStoragePaths } from "./paths";
import {
	createMemoryProjectSnapshot,
	type MemoryProjectSnapshot,
} from "./snapshot";
import type { MemoryFreshnessResult } from "./verification";
import { analyzeMemoryFreshness, applyMemoryFreshness } from "./verification";

export const MEMORY_GATE_REQUIRED_CHECKS = [
	"file_index",
	"symbols",
	"relations",
	"effects",
] as const;

export type MemoryGateRequiredCheck =
	(typeof MEMORY_GATE_REQUIRED_CHECKS)[number];

export interface MemoryGateInspection {
	clean: boolean;
	repoRoot: string;
	snapshot: MemoryProjectSnapshot;
	freshness: MemoryFreshnessResult;
	requiredChecks: readonly MemoryGateRequiredCheck[];
	nextAction: "continue" | "update_memory";
	instruction: string;
}

export async function inspectMemoryGate(input: {
	fs: PlannerFs;
	git: GitRunner;
	repoRoot: string;
	memoryPaths: MemoryStoragePaths;
}): Promise<MemoryGateInspection> {
	const snapshot = await createMemoryProjectSnapshot({
		fs: input.fs,
		git: input.git,
		repoRoot: input.repoRoot,
	});
	const freshness = await analyzeMemoryFreshness({
		fs: input.fs,
		paths: input.memoryPaths,
		currentFiles: snapshot.files,
	});

	return buildMemoryGateInspection({
		repoRoot: input.repoRoot,
		snapshot,
		freshness,
	});
}

export async function applyMemoryGateFreshness(input: {
	fs: PlannerFs;
	git: GitRunner;
	repoRoot: string;
	memoryPaths: MemoryStoragePaths;
	detectedAt: string;
}): Promise<MemoryGateInspection> {
	const snapshot = await createMemoryProjectSnapshot({
		fs: input.fs,
		git: input.git,
		repoRoot: input.repoRoot,
	});
	const freshness = await applyMemoryFreshness({
		fs: input.fs,
		paths: input.memoryPaths,
		currentFiles: snapshot.files,
		detectedAt: input.detectedAt,
	});

	return buildMemoryGateInspection({
		repoRoot: input.repoRoot,
		snapshot,
		freshness,
	});
}

function buildMemoryGateInspection(input: {
	repoRoot: string;
	snapshot: MemoryProjectSnapshot;
	freshness: MemoryFreshnessResult;
}): MemoryGateInspection {
	const clean =
		input.freshness.clean && input.snapshot.missingFiles.length === 0;
	return {
		clean,
		repoRoot: input.repoRoot,
		snapshot: input.snapshot,
		freshness: input.freshness,
		requiredChecks: clean ? [] : MEMORY_GATE_REQUIRED_CHECKS,
		nextAction: clean ? "continue" : "update_memory",
		instruction: clean
			? "Memory matches the current project snapshot. Continue with the planner state machine."
			: buildMemoryUpdateInstruction(input.freshness),
	};
}

function buildMemoryUpdateInstruction(
	freshness: MemoryFreshnessResult,
): string {
	return [
		"Memory is stale. Update memory before compact or stage transition.",
		`Files to reindex: ${freshness.filesToReindex.join(", ") || "(none)"}.`,
		`Affected symbols: ${freshness.affectedSymbolIds.join(", ") || "(none)"}.`,
		`Affected relations: ${freshness.affectedRelationIds.join(", ") || "(none)"}.`,
		"Required checks: file_index, symbols, relations, effects.",
		'Re-evaluate effects for every affected symbol; if unsure, use globalState="unknown" and record uncertainty.',
	].join("\n");
}
