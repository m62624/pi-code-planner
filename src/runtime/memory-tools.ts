import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { GitRunner } from "../git/runner";
import {
	applyMemoryGateFreshness,
	inspectMemoryGate,
	type MemoryGateInspection,
} from "../memory/gate";
import {
	addActiveMemoryCandidateSymbols,
	claimNextMemoryIndexingFile,
	completeActiveMemoryFile,
	ignoreActiveMemoryFile,
	readActiveMemoryFileChunk,
	readMemoryIndexingState,
	scanMemoryIndexingQueue,
	summarizeMemoryIndexing,
	upsertActiveMemoryFile,
	verifyActiveMemoryFile,
} from "../memory/indexing";
import {
	clearMemoryDirty,
	readFileIndex,
	readMemoryCheckpoint,
	readMemoryDirtyState,
	writeMemoryCheckpoint,
	writeProjectPatterns,
} from "../memory/manager";
import { searchProjectFiles } from "../memory/project-search";
import { retrieveMemoryContext } from "../memory/retrieval";
import { MEMORY_FILE_KINDS, type MemoryFileKind } from "../memory/schema";
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
	"planner_memory_scan_project",
	"planner_memory_search_project",
	"planner_memory_index_status",
	"planner_memory_next_file",
	"planner_memory_read_chunk",
	"planner_memory_upsert_active_file",
	"planner_memory_write_project_patterns",
	"planner_memory_upsert_symbols",
	"planner_memory_verify_active_file",
	"planner_memory_complete_active_file",
	"planner_memory_ignore_active_file",
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

	try {
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
			case "planner_memory_scan_project": {
				const params = asObject(input.params);
				const inspection =
					orchestrator.preflight.memoryGate ??
					(await inspectMemoryGate({
						fs: input.fs,
						git: input.git,
						repoRoot: ready.worktreePath,
						memoryPaths: ready.memoryPaths,
					}));
				const mode = ready.orchestrator.preflight.context.state
					.requiresMemoryUpdate
					? "refresh"
					: "initial_discovery";
				const state = await scanMemoryIndexingQueue({
					fs: input.fs,
					git: input.git,
					repoRoot: ready.worktreePath,
					paths: ready.memoryPaths,
					mode,
					onlyPaths:
						mode === "refresh"
							? inspection.freshness.filesToReindex
							: (stringArrayOrUndefined(params.paths) ?? []),
				});
				return applied(input.toolName, formatMemoryIndexingState(state), {
					state,
					summary: summarizeMemoryIndexing(state),
				});
			}
			case "planner_memory_search_project": {
				const params = asObject(input.params);
				const result = await searchProjectFiles({
					fs: input.fs,
					git: input.git,
					repoRoot: ready.worktreePath,
					query: requiredString(params, "query"),
					limit: numberOrUndefined(params.limit),
				});
				return applied(
					input.toolName,
					[
						"Planner selective project search result.",
						"Use the smallest relevant path set with planner_memory_scan_project. Broaden the query only when context is insufficient.",
						JSON.stringify(result, null, 2),
					].join("\n"),
					{ result },
				);
			}
			case "planner_memory_index_status": {
				const state = await readMemoryIndexingState(
					input.fs,
					ready.memoryPaths,
				);
				return applied(input.toolName, formatMemoryIndexingState(state), {
					state,
					summary: summarizeMemoryIndexing(state),
				});
			}
			case "planner_memory_next_file": {
				const file = await claimNextMemoryIndexingFile(
					input.fs,
					ready.memoryPaths,
				);
				const state = await readMemoryIndexingState(
					input.fs,
					ready.memoryPaths,
				);
				return applied(
					input.toolName,
					file
						? [
								`Planner memory active file: ${file.path}.`,
								`Lines: ${file.lineCount}. Continue from line ${file.nextUnreadLine}.`,
								"Call planner_memory_read_chunk. Do not read another file until this file is verified and completed.",
							].join("\n")
						: formatMemoryIndexingState(state),
					{ file, state, summary: summarizeMemoryIndexing(state) },
				);
			}
			case "planner_memory_read_chunk": {
				const params = asObject(input.params);
				const chunk = await readActiveMemoryFileChunk({
					fs: input.fs,
					repoRoot: ready.worktreePath,
					paths: ready.memoryPaths,
					maxLines: numberOrUndefined(params.maxLines),
				});
				return applied(
					input.toolName,
					[
						`Planner memory source chunk: ${chunk.path}.`,
						`Lines ${chunk.startLine}-${chunk.endLine} of ${chunk.lineCount}.`,
						`Next unread line: ${chunk.nextUnreadLine}.`,
						`EOF: ${String(chunk.eof)}.`,
						"",
						chunk.content || "(empty file)",
					].join("\n"),
					{ chunk },
				);
			}
			case "planner_memory_upsert_active_file": {
				const params = asObject(input.params);
				const file = await upsertActiveMemoryFile({
					fs: input.fs,
					repoRoot: ready.worktreePath,
					paths: ready.memoryPaths,
					kind: requiredMemoryFileKind(params, "kind"),
					language: requiredString(params, "language"),
					summary: requiredString(params, "summary"),
				});
				await refreshMemoryCheckpointHashes(input.fs, ready.memoryPaths);
				return applied(
					input.toolName,
					[
						`Planner memory file metadata recorded: ${file.path}.`,
						"Record reusable symbols in batches of at most 5 with planner_memory_upsert_symbols.",
						"When symbol extraction is complete, call planner_memory_verify_active_file.",
					].join("\n"),
					{ file },
				);
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
			case "planner_memory_upsert_symbols": {
				const params = asObject(input.params);
				const symbols = limitedArray(params.symbols, "symbols");
				const prepared = await prepareSymbolEntries({
					fs: input.fs,
					paths: ready.memoryPaths,
					worktreePath: ready.worktreePath,
					symbols,
				});
				const result = await writeMemoryBatchWithReferences({
					fs: input.fs,
					paths: ready.memoryPaths,
					symbols: prepared.entries,
				});
				appendRejected(result, prepared.rejected);
				if (result.accepted.symbols.length > 0) {
					await addActiveMemoryCandidateSymbols({
						fs: input.fs,
						paths: ready.memoryPaths,
						symbols: result.accepted.symbols,
					});
				}
				await refreshMemoryCheckpointHashes(input.fs, ready.memoryPaths);
				return applied(
					input.toolName,
					formatMemoryWriteResult("symbol", result),
					{ result },
				);
			}
			case "planner_memory_verify_active_file": {
				const file = await verifyActiveMemoryFile({
					fs: input.fs,
					repoRoot: ready.worktreePath,
					paths: ready.memoryPaths,
				});
				return applied(
					input.toolName,
					[
						`Planner memory active file verified: ${file.path}.`,
						"Call planner_memory_complete_active_file before claiming another file.",
					].join("\n"),
					{ file },
				);
			}
			case "planner_memory_complete_active_file": {
				const state = await completeActiveMemoryFile({
					fs: input.fs,
					repoRoot: ready.worktreePath,
					paths: ready.memoryPaths,
				});
				await refreshMemoryCheckpointHashes(input.fs, ready.memoryPaths);
				return applied(input.toolName, formatMemoryIndexingState(state), {
					state,
					summary: summarizeMemoryIndexing(state),
				});
			}
			case "planner_memory_ignore_active_file": {
				const params = asObject(input.params);
				const state = await ignoreActiveMemoryFile({
					fs: input.fs,
					repoRoot: ready.worktreePath,
					paths: ready.memoryPaths,
					kind: requiredMemoryFileKind(params, "kind"),
					language: requiredString(params, "language"),
					summary: requiredString(params, "summary"),
				});
				await refreshMemoryCheckpointHashes(input.fs, ready.memoryPaths);
				return applied(input.toolName, formatMemoryIndexingState(state), {
					state,
					summary: summarizeMemoryIndexing(state),
				});
			}
			case "planner_memory_upsert_relations": {
				const params = asObject(input.params);
				const relations = limitedArray(params.relations, "relations");
				const result = await writeMemoryBatchWithReferences({
					fs: input.fs,
					paths: ready.memoryPaths,
					relations: await prepareRelationEntries({
						fs: input.fs,
						worktreePath: ready.worktreePath,
						relations,
					}),
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
				const indexingBlock = await incompleteIndexingQueueReason(
					input.fs,
					ready.memoryPaths,
				);
				if (indexingBlock) {
					return blocked(input.toolName, indexingBlock, {
						indexing: await readMemoryIndexingState(
							input.fs,
							ready.memoryPaths,
						),
					});
				}
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
				const indexingBlock = await incompleteIndexingQueueReason(
					input.fs,
					ready.memoryPaths,
				);
				if (indexingBlock) {
					return blocked(input.toolName, indexingBlock, {
						indexing: await readMemoryIndexingState(
							input.fs,
							ready.memoryPaths,
						),
					});
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
	} catch (error) {
		return blocked(input.toolName, errorMessage(error), { error });
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

async function incompleteIndexingQueueReason(
	fs: PlannerFs,
	memoryPaths: NonNullable<
		PlannerOrchestratorResult["preflight"]["memoryPaths"]
	>,
): Promise<string | null> {
	const state = await readMemoryIndexingState(fs, memoryPaths);
	const summary = summarizeMemoryIndexing(state);
	if (summary.complete) {
		return null;
	}
	return [
		"Planner memory indexing queue is incomplete. Global verification and checkpoint sync are blocked.",
		`Mode=${summary.mode}; active=${summary.activeFile ?? "(none)"}; pending=${summary.pending}; reading=${summary.reading}; verifying=${summary.verifying}; failed=${summary.failed}.`,
		"Call planner_memory_index_status and finish the exact active file before global verification.",
	].join("\n");
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

function stringArrayOrUndefined(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (
		!Array.isArray(value) ||
		!value.every((item) => typeof item === "string")
	) {
		throw new TypeError("paths must be a string array.");
	}
	return value;
}

async function prepareSymbolEntries(input: {
	fs: PlannerFs;
	paths: NonNullable<PlannerOrchestratorResult["preflight"]["memoryPaths"]>;
	worktreePath: string;
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
	const indexing = await readMemoryIndexingState(input.fs, input.paths);
	const activeFile = indexing.activeFile
		? indexing.files.find((entry) => entry.path === indexing.activeFile)
		: null;
	const entries: unknown[] = [];
	const rejected: MemoryBatchRejectedEntry[] = [];
	for (const [index, value] of input.symbols.entries()) {
		const entry = asObject(value);
		const path = optionalString(entry, "path");
		const file = path ? indexedFiles.get(path) : null;
		if (
			!activeFile ||
			activeFile.status !== "verifying" ||
			path !== activeFile.path
		) {
			rejected.push({
				kind: "symbol",
				index,
				id: optionalString(entry, "id") ?? null,
				reasons: [
					"Symbol path must match the active verifying file. Claim, fully read, and record one active file before writing its symbols.",
				],
			});
			continue;
		}
		if (!path || !file) {
			rejected.push({
				kind: "symbol",
				index,
				id: optionalString(entry, "id") ?? null,
				reasons: [
					"Symbol path must reference an indexed active file. Call planner_memory_upsert_active_file first.",
				],
			});
			continue;
		}
		const name = optionalString(entry, "name") ?? "";
		const qualifiedName = optionalString(entry, "qualifiedName") ?? name;
		const kind = optionalString(entry, "kind") ?? "unknown";
		const signature = optionalString(entry, "signature") ?? "";
		const anchor = asObject(entry.anchor);
		const anchorSearchText =
			optionalString(anchor, "searchText") ??
			optionalString(entry, "anchorSearchText") ??
			(signature || name);
		const content = await input.fs.readText(join(input.worktreePath, path));
		if (!anchorSearchText || !content.includes(anchorSearchText)) {
			rejected.push({
				kind: "symbol",
				index,
				id: optionalString(entry, "id") ?? null,
				reasons: [
					"Symbol anchorSearchText must be a non-empty exact substring of the indexed source file.",
				],
			});
			continue;
		}
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
				searchText: anchorSearchText,
			},
			verification: { fileHash: file.hash, status: "verified" },
		});
	}
	return { entries, rejected };
}

async function prepareRelationEntries(input: {
	fs: PlannerFs;
	worktreePath: string;
	relations: readonly unknown[];
}): Promise<unknown[]> {
	const prepared: unknown[] = [];
	for (const value of input.relations) {
		const entry = asObject(value);
		const from = optionalString(entry, "from") ?? "";
		const to = entry.to === null ? null : (optionalString(entry, "to") ?? "");
		const kind = optionalString(entry, "kind") ?? "unknown";
		const evidencePath = optionalString(entry, "evidencePath") ?? "";
		const evidenceSearchText =
			optionalString(entry, "evidenceSearchText") ?? "";
		if (
			!evidencePath ||
			isAbsolute(evidencePath) ||
			evidencePath.split(/[\\/]/).includes("..")
		) {
			throw new TypeError(
				"Relation evidencePath must be a safe project-relative path.",
			);
		}
		const content = await input.fs.readText(
			join(input.worktreePath, evidencePath),
		);
		if (!evidenceSearchText || !content.includes(evidenceSearchText)) {
			throw new TypeError(
				`Relation evidenceSearchText must be an exact substring of ${evidencePath}.`,
			);
		}
		prepared.push({
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
		});
	}
	return prepared;
}

function formatMemoryIndexingState(
	state: Awaited<ReturnType<typeof readMemoryIndexingState>>,
): string {
	const summary = summarizeMemoryIndexing(state);
	const active = state.activeFile
		? state.files.find((entry) => entry.path === state.activeFile)
		: null;
	return [
		"Planner memory indexing status.",
		`Mode: ${summary.mode}.`,
		`Files: total=${summary.total}, pending=${summary.pending}, reading=${summary.reading}, verifying=${summary.verifying}, indexed=${summary.indexed}, ignored=${summary.ignored}, missing=${summary.missing}, failed=${summary.failed}.`,
		`Complete: ${String(summary.complete)}.`,
		active
			? `Active file: ${active.path}; next unread line=${active.nextUnreadLine}; line count=${active.lineCount}; verification passed=${String(active.verificationPassed)}.`
			: "Active file: (none).",
		summary.complete
			? "File indexing queue is complete. Call planner_status before continuing."
			: active
				? "Continue the active file. Do not claim or read a different file."
				: "Call planner_memory_next_file.",
	].join("\n");
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

function numberOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function limitedArray(value: unknown, key: string): readonly unknown[] {
	if (!Array.isArray(value)) {
		throw new TypeError(`${key} must be an array.`);
	}
	if (value.length > 5) {
		throw new TypeError(`${key} accepts at most 5 entries per call.`);
	}
	return value;
}

function requiredMemoryFileKind(
	params: Record<string, unknown>,
	key: string,
): MemoryFileKind {
	const value = requiredString(params, key);
	if (!MEMORY_FILE_KINDS.includes(value as MemoryFileKind)) {
		throw new TypeError(`${key} has unsupported value: ${value}.`);
	}
	return value as MemoryFileKind;
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
