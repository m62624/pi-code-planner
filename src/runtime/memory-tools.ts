import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { GitRunner } from "../git/runner";
import {
	applyMemoryGateFreshness,
	inspectMemoryGate,
	type MemoryGateInspection,
} from "../memory/gate";
import {
	clearMemoryDirty,
	readFileIndex,
	readMemoryCheckpoint,
	readMemoryDirtyState,
	writeMemoryCheckpoint,
	writeProjectPatterns,
} from "../memory/manager";
import { retrieveMemoryContext } from "../memory/retrieval";
import type {
	MemoryBatchRejectedEntry,
	MemoryBatchWriteResult,
} from "../memory/write-api";
import { writeMemoryBatchWithReferences } from "../memory/write-api";
import type { PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import { savePlanState } from "../storage/state-store";
import { markMemoryCheckpointSynced } from "./git-state-sync";
import {
	checkPlannerOrchestratorToolAllowed,
	type PlannerOrchestratorResult,
	runPlannerOrchestrator,
} from "./orchestrator";

export const PLANNER_MEMORY_TOOL_NAMES = [
	"planner_memory_inspect",
	"planner_memory_apply_freshness",
	"planner_memory_write_project_patterns",
	"planner_memory_upsert_files",
	"planner_memory_upsert_symbols",
	"planner_memory_upsert_relations",
	"planner_memory_search",
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
	orchestrator: PlannerOrchestratorResult & {
		preflight: PlannerOrchestratorResult["preflight"] & {
			context: Extract<
				PlannerOrchestratorResult["preflight"]["context"],
				{ status: "ready" }
			>;
		};
	};
	worktreePath: string;
	memoryPaths: NonNullable<
		PlannerOrchestratorResult["preflight"]["memoryPaths"]
	>;
}

export async function executePlannerMemoryTool(
	input: PlannerMemoryToolExecutionInput,
): Promise<PlannerMemoryToolExecutionResult> {
	const orchestrator = await runPlannerOrchestrator(input);
	const ready = readyMemoryContext(orchestrator, input.toolName);
	if (ready.status === "blocked") {
		return ready.result;
	}

	switch (input.toolName) {
		case "planner_memory_inspect": {
			const inspection =
				orchestrator.preflight.memoryGate ??
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
		case "planner_memory_write_project_patterns": {
			const params = asObject(input.params);
			const content = requiredString(params, "content");
			await writeProjectPatterns(input.fs, ready.memoryPaths, content);
			return applied(
				input.toolName,
				[
					"Planner project patterns written.",
					`Artifact: ${ready.memoryPaths.projectPatternsMd}`,
					"Call planner_status before choosing the next planner action.",
				].join("\n"),
				{ projectPatternsMd: ready.memoryPaths.projectPatternsMd },
			);
		}
		case "planner_memory_upsert_files": {
			const params = asObject(input.params);
			const prepared = await prepareFileEntries({
				fs: input.fs,
				worktreePath: ready.worktreePath,
				files: arrayOrUndefined(params.files) ?? [],
			});
			const result = await writeMemoryBatchWithReferences({
				fs: input.fs,
				paths: ready.memoryPaths,
				files: prepared.entries,
			});
			appendRejected(result, prepared.rejected);
			await refreshMemoryCheckpointHashes(input.fs, ready.memoryPaths);
			return applied(input.toolName, formatMemoryWriteResult("file", result), {
				result,
			});
		}
		case "planner_memory_upsert_symbols": {
			const params = asObject(input.params);
			const prepared = await prepareSymbolEntries({
				fs: input.fs,
				paths: ready.memoryPaths,
				symbols: arrayOrUndefined(params.symbols) ?? [],
			});
			const result = await writeMemoryBatchWithReferences({
				fs: input.fs,
				paths: ready.memoryPaths,
				symbols: prepared.entries,
			});
			appendRejected(result, prepared.rejected);
			await refreshMemoryCheckpointHashes(input.fs, ready.memoryPaths);
			return applied(
				input.toolName,
				formatMemoryWriteResult("symbol", result),
				{ result },
			);
		}
		case "planner_memory_upsert_relations": {
			const params = asObject(input.params);
			const result = await writeMemoryBatchWithReferences({
				fs: input.fs,
				paths: ready.memoryPaths,
				relations: prepareRelationEntries(
					arrayOrUndefined(params.relations) ?? [],
				),
			});
			await refreshMemoryCheckpointHashes(input.fs, ready.memoryPaths);
			return applied(
				input.toolName,
				formatMemoryWriteResult("relation", result),
				{ result },
			);
		}
		case "planner_memory_search": {
			const params = asObject(input.params);
			const result = await retrieveMemoryContext({
				fs: input.fs,
				paths: ready.memoryPaths,
				query: optionalString(params, "query"),
				cursor: objectOrUndefined(params.cursor),
				limits: objectOrUndefined(params.limits),
				filters: objectOrUndefined(params.filters),
				includeProjectPatterns: booleanOrUndefined(
					params.includeProjectPatterns,
				),
				includeDirtyState: booleanOrUndefined(params.includeDirtyState),
			});
			return applied(
				input.toolName,
				[
					"Planner bounded memory search result.",
					JSON.stringify(result, null, 2),
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
			if (orchestrator.preflight.gitReality?.isDirty) {
				return blocked(
					input.toolName,
					"Cannot sync planner memory checkpoint while the worktree is dirty. Commit planner changes first with planner_git_commit, then update and verify memory for the new HEAD.",
					{ gitReality: orchestrator.preflight.gitReality },
				);
			}
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
			const head = orchestrator.preflight.gitReality?.headCommit;
			if (!head) {
				return blocked(input.toolName, "Git HEAD is unavailable.", {
					orchestrator,
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
				state: ready.orchestrator.preflight.context.state,
				headCommit: head,
			});
			await savePlanState(
				input.fs,
				ready.orchestrator.preflight.context.planPaths,
				state,
			);
			return applied(
				input.toolName,
				"Planner memory checkpoint synced. Normal planner flow may continue.",
				{ checkpointCommit: head, state },
			);
		}
	}
}

function readyMemoryContext(
	orchestrator: PlannerOrchestratorResult,
	toolName: PlannerMemoryToolName,
):
	| ReadyMemoryContext
	| {
			status: "blocked";
			result: PlannerMemoryToolExecutionResult;
	  } {
	if (orchestrator.preflight.context.status !== "ready") {
		return {
			status: "blocked",
			result: blocked(toolName, orchestrator.preflight.context.reason, {
				orchestrator,
			}),
		};
	}
	const policy = checkPlannerOrchestratorToolAllowed({
		orchestrator,
		toolName,
	});
	if (!policy.allow) {
		return {
			status: "blocked",
			result: blocked(
				toolName,
				policy.reason ?? `Planner memory tool ${toolName} is blocked.`,
				{ orchestrator, policy },
			),
		};
	}
	if (
		!orchestrator.preflight.context.state.worktreePath ||
		!orchestrator.preflight.memoryPaths
	) {
		return {
			status: "blocked",
			result: blocked(
				toolName,
				"Planner worktree or memory paths are missing.",
				{
					orchestrator,
				},
			),
		};
	}
	return {
		status: "ready",
		orchestrator: orchestrator as ReadyMemoryContext["orchestrator"],
		worktreePath: orchestrator.preflight.context.state.worktreePath,
		memoryPaths: orchestrator.preflight.memoryPaths,
	};
}

async function refreshMemoryCheckpointHashes(
	fs: PlannerFs,
	memoryPaths: NonNullable<
		PlannerOrchestratorResult["preflight"]["memoryPaths"]
	>,
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

async function prepareFileEntries(input: {
	fs: PlannerFs;
	worktreePath: string;
	files: readonly unknown[];
}): Promise<{
	entries: unknown[];
	rejected: MemoryBatchRejectedEntry[];
}> {
	const entries: unknown[] = [];
	const rejected: MemoryBatchRejectedEntry[] = [];
	for (const [index, value] of input.files.entries()) {
		const entry = asObject(value);
		const path = optionalString(entry, "path");
		if (!path || !isSafeRelativePath(input.worktreePath, path)) {
			rejected.push({
				kind: "file",
				index,
				id: path ?? null,
				reasons: ["path must be a safe project-relative file path."],
			});
			continue;
		}
		try {
			const content = await input.fs.readText(join(input.worktreePath, path));
			entries.push({
				...entry,
				path,
				hash: hashText(content),
				status: "indexed",
			});
		} catch (error) {
			rejected.push({
				kind: "file",
				index,
				id: path,
				reasons: [`Cannot read project file: ${errorMessage(error)}`],
			});
		}
	}
	return { entries, rejected };
}

async function prepareSymbolEntries(input: {
	fs: PlannerFs;
	paths: NonNullable<PlannerOrchestratorResult["preflight"]["memoryPaths"]>;
	symbols: readonly unknown[];
}): Promise<{
	entries: unknown[];
	rejected: MemoryBatchRejectedEntry[];
}> {
	const indexedFiles = new Map(
		(await readFileIndex(input.fs, input.paths)).map((entry) => [
			entry.path,
			entry,
		]),
	);
	const entries: unknown[] = [];
	const rejected: MemoryBatchRejectedEntry[] = [];
	for (const [index, value] of input.symbols.entries()) {
		const entry = asObject(value);
		const path = optionalString(entry, "path");
		const file = path ? indexedFiles.get(path) : null;
		if (!path || !file) {
			rejected.push({
				kind: "symbol",
				index,
				id: optionalString(entry, "id") ?? null,
				reasons: [
					"Symbol path must reference an indexed file. Call planner_memory_upsert_files first.",
				],
			});
			continue;
		}
		const name = optionalString(entry, "name") ?? "";
		const qualifiedName = optionalString(entry, "qualifiedName") ?? name;
		const kind = optionalString(entry, "kind") ?? "unknown";
		const signature = optionalString(entry, "signature") ?? "";
		const anchor = asObject(entry.anchor);
		entries.push({
			id:
				optionalString(entry, "id") ??
				stableMemoryId("sym", [path, qualifiedName, kind]),
			path,
			language: optionalString(entry, "language") ?? file.language,
			kind,
			name,
			qualifiedName,
			signature,
			summary: optionalString(entry, "summary") ?? "",
			visibility: optionalString(entry, "visibility") ?? "unknown",
			effects: entry.effects,
			anchor: {
				searchText:
					optionalString(anchor, "searchText") ??
					optionalString(entry, "anchorSearchText") ??
					(signature || name),
			},
			verification: { fileHash: file.hash, status: "verified" },
		});
	}
	return { entries, rejected };
}

function prepareRelationEntries(relations: readonly unknown[]): unknown[] {
	return relations.map((value) => {
		const entry = asObject(value);
		const from = optionalString(entry, "from") ?? "";
		const to = entry.to === null ? null : (optionalString(entry, "to") ?? "");
		const kind = optionalString(entry, "kind") ?? "unknown";
		const evidencePath = optionalString(entry, "evidencePath") ?? "";
		const evidenceSearchText =
			optionalString(entry, "evidenceSearchText") ?? "";
		return {
			id:
				optionalString(entry, "id") ??
				stableMemoryId("rel", [
					from,
					to ?? "",
					kind,
					evidencePath,
					evidenceSearchText,
				]),
			from,
			to,
			kind,
			evidencePath,
			evidenceSearchText,
		};
	});
}

function formatMemoryWriteResult(
	kind: "file" | "symbol" | "relation",
	result: MemoryBatchWriteResult,
): string {
	const lines = [
		`Planner ${kind} memory entries processed.`,
		`Accepted: ${result.totals.accepted}.`,
		`Rejected: ${result.totals.rejected}.`,
	];
	if (result.rejected.length > 0) {
		lines.push(
			"Fix every rejected entry before continuing:",
			...result.rejected.map(
				(entry) =>
					`- ${entry.kind}[${entry.index}] ${entry.id ?? "(unknown id)"}: ${entry.reasons.join("; ")}`,
			),
			"Call planner_status after correcting the rejected entries.",
		);
		return lines.join("\n");
	}
	lines.push("Call planner_status before choosing the next planner action.");
	return lines.join("\n");
}

function appendRejected(
	result: MemoryBatchWriteResult,
	rejected: readonly MemoryBatchRejectedEntry[],
): void {
	result.rejected.push(...rejected);
	result.totals.input += rejected.length;
	result.totals.rejected += rejected.length;
}

function hashText(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function stableMemoryId(
	prefix: "sym" | "rel",
	parts: readonly string[],
): string {
	return `${prefix}_${hashText(JSON.stringify(parts)).slice(0, 16)}`;
}

function isSafeRelativePath(root: string, path: string): boolean {
	if (isAbsolute(path)) return false;
	const target = resolve(root, path);
	const fromRoot = relative(resolve(root), target);
	return (
		fromRoot !== ".." &&
		!fromRoot.startsWith("../") &&
		!fromRoot.startsWith("..\\") &&
		!isAbsolute(fromRoot)
	);
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

function objectOrUndefined<T extends object>(value: unknown): T | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as T)
		: undefined;
}

function optionalString(
	params: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = params[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function requiredString(params: Record<string, unknown>, key: string): string {
	const value = optionalString(params, key);
	if (!value) {
		throw new TypeError(`${key} must be a non-empty string.`);
	}
	return value;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function nowIso(params: unknown): string {
	const detectedAt = asObject(params).detectedAt;
	return typeof detectedAt === "string" && detectedAt.trim().length > 0
		? detectedAt
		: new Date().toISOString();
}
