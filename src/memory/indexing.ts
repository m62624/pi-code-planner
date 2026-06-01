import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { GitRunner } from "../git/runner";
import type { PlannerFs } from "../storage/fs";
import { readJsonIfExists, writeJson } from "../storage/json";
import {
	createEmptyMemoryIndexingState,
	readFileIndex,
	readRelationIndex,
	readSymbolIndex,
	removeFileEntries,
	removeRelationEntries,
	removeSymbolEntries,
	upsertFileEntries,
} from "./manager";
import type { MemoryStoragePaths } from "./paths";
import type {
	MemoryFileKind,
	MemoryIndexingFileEntry,
	MemoryIndexingFileStatus,
	MemoryIndexingMode,
	MemoryIndexingState,
	MemorySymbolEntry,
} from "./schema";

export const DEFAULT_MEMORY_CHUNK_LINES = 200;
export const MAX_MEMORY_CHUNK_LINES = 400;

export interface MemoryIndexingSummary {
	mode: MemoryIndexingMode;
	activeFile: string | null;
	total: number;
	pending: number;
	reading: number;
	verifying: number;
	indexed: number;
	ignored: number;
	missing: number;
	failed: number;
	complete: boolean;
}

export interface MemoryIndexingReadChunk {
	path: string;
	hash: string;
	startLine: number;
	endLine: number;
	lineCount: number;
	nextUnreadLine: number;
	eof: boolean;
	content: string;
}

export async function readMemoryIndexingState(
	fs: PlannerFs,
	paths: MemoryStoragePaths,
): Promise<MemoryIndexingState> {
	const state = await readJsonIfExists<MemoryIndexingState>(
		fs,
		paths.indexingJson,
	);
	const resolved = state ?? createEmptyMemoryIndexingState();
	assertMemoryIndexingState(resolved);
	return resolved;
}

export async function writeMemoryIndexingState(
	fs: PlannerFs,
	paths: MemoryStoragePaths,
	state: MemoryIndexingState,
): Promise<void> {
	assertMemoryIndexingState(state);
	await writeJson(fs, paths.indexingJson, state);
}

export async function scanMemoryIndexingQueue(input: {
	fs: PlannerFs;
	git: GitRunner;
	repoRoot: string;
	paths: MemoryStoragePaths;
	mode: Exclude<MemoryIndexingMode, "idle">;
	onlyPaths?: readonly string[];
}): Promise<MemoryIndexingState> {
	const listedPaths = uniqueSorted(await input.git.listProjectFiles(input));
	const listedSet = new Set(listedPaths);
	const targetPaths =
		input.mode === "refresh" && input.onlyPaths
			? uniqueSorted(input.onlyPaths)
			: listedPaths;
	const current = await readMemoryIndexingState(input.fs, input.paths);
	const canResume = current.mode === input.mode;
	const previous = new Map(current.files.map((entry) => [entry.path, entry]));
	const files: MemoryIndexingFileEntry[] = [];

	for (const path of targetPaths) {
		assertSafeRelativePath(path);
		if (!listedSet.has(path)) {
			files.push(missingFile(path));
			await purgeIndexedFile(input.fs, input.paths, path);
			continue;
		}
		try {
			const content = await input.fs.readText(join(input.repoRoot, path));
			const hash = hashText(content);
			const lineCount = splitLines(content).length;
			const prior = previous.get(path);
			files.push(
				canResume && prior?.hash === hash
					? { ...prior, lineCount }
					: pendingFile(path, hash, lineCount),
			);
		} catch (error) {
			files.push(failedFile(path, errorMessage(error)));
		}
	}

	const filePaths = new Set(files.map((entry) => entry.path));
	const activeFile =
		canResume &&
		current.activeFile !== null &&
		filePaths.has(current.activeFile) &&
		files.some(
			(entry) =>
				entry.path === current.activeFile &&
				(entry.status === "reading" || entry.status === "verifying"),
		)
			? current.activeFile
			: null;
	const state = { mode: input.mode, activeFile, files };
	await writeMemoryIndexingState(input.fs, input.paths, state);
	return state;
}

export async function claimNextMemoryIndexingFile(
	fs: PlannerFs,
	paths: MemoryStoragePaths,
): Promise<MemoryIndexingFileEntry | null> {
	const state = await readMemoryIndexingState(fs, paths);
	if (state.activeFile) {
		return requiredActiveFile(state);
	}
	const pending = state.files.find((entry) => entry.status === "pending");
	if (!pending) {
		return null;
	}
	const next = updateFile(state, pending.path, (entry) => ({
		...entry,
		status: "reading",
	}));
	next.activeFile = pending.path;
	await writeMemoryIndexingState(fs, paths, next);
	return requiredActiveFile(next);
}

export async function readActiveMemoryFileChunk(input: {
	fs: PlannerFs;
	repoRoot: string;
	paths: MemoryStoragePaths;
	maxLines?: number;
}): Promise<MemoryIndexingReadChunk> {
	const state = await readMemoryIndexingState(input.fs, input.paths);
	const active = requiredActiveFile(state);
	if (active.status !== "reading") {
		throw new Error(
			`Active memory file ${active.path} is ${active.status}; chunks can only be read while status=reading.`,
		);
	}
	const content = await readUnchangedActiveFile(
		input.fs,
		input.repoRoot,
		active,
	);
	const lines = splitLines(content);
	const startLine = active.nextUnreadLine;
	const limit = clampChunkLines(input.maxLines);
	const selected = lines.slice(startLine - 1, startLine - 1 + limit);
	const endLine = selected.length > 0 ? startLine + selected.length - 1 : 0;
	const nextUnreadLine =
		selected.length > 0 ? endLine + 1 : Math.max(1, active.lineCount + 1);
	const next = updateFile(state, active.path, (entry) => ({
		...entry,
		nextUnreadLine,
	}));
	await writeMemoryIndexingState(input.fs, input.paths, next);
	return {
		path: active.path,
		hash: requiredHash(active),
		startLine,
		endLine,
		lineCount: active.lineCount,
		nextUnreadLine,
		eof: nextUnreadLine > active.lineCount,
		content: selected
			.map((line, index) => `${startLine + index} | ${line}`)
			.join("\n"),
	};
}

export async function upsertActiveMemoryFile(input: {
	fs: PlannerFs;
	repoRoot: string;
	paths: MemoryStoragePaths;
	kind: MemoryFileKind;
	language: string;
	summary: string;
}): Promise<MemoryIndexingFileEntry> {
	const state = await readMemoryIndexingState(input.fs, input.paths);
	const active = requiredActiveFile(state);
	assertFullyRead(active);
	await readUnchangedActiveFile(input.fs, input.repoRoot, active);
	await upsertFileEntries(input.fs, input.paths, [
		{
			path: active.path,
			kind: input.kind,
			language: requiredText(input.language, "language"),
			hash: requiredHash(active),
			status: "indexed",
			summary: requiredText(input.summary, "summary"),
		},
	]);
	const next = updateFile(state, active.path, (entry) => ({
		...entry,
		status: "verifying",
		verificationPassed: false,
		failureReason: null,
	}));
	await writeMemoryIndexingState(input.fs, input.paths, next);
	return requiredActiveFile(next);
}

export async function addActiveMemoryCandidateSymbols(input: {
	fs: PlannerFs;
	paths: MemoryStoragePaths;
	symbols: readonly MemorySymbolEntry[];
}): Promise<MemoryIndexingFileEntry> {
	const state = await readMemoryIndexingState(input.fs, input.paths);
	const active = requiredActiveFile(state);
	if (active.status !== "verifying") {
		throw new Error(
			`Active memory file ${active.path} must be verifying before symbols are recorded.`,
		);
	}
	for (const symbol of input.symbols) {
		if (symbol.path !== active.path) {
			throw new Error(
				`Symbol ${symbol.id} belongs to ${symbol.path}; active file is ${active.path}.`,
			);
		}
	}
	const candidateSymbolIds = uniqueSorted([
		...active.candidateSymbolIds,
		...input.symbols.map((symbol) => symbol.id),
	]);
	const next = updateFile(state, active.path, (entry) => ({
		...entry,
		candidateSymbolIds,
		verificationPassed: false,
	}));
	await writeMemoryIndexingState(input.fs, input.paths, next);
	return requiredActiveFile(next);
}

export async function verifyActiveMemoryFile(input: {
	fs: PlannerFs;
	repoRoot: string;
	paths: MemoryStoragePaths;
}): Promise<MemoryIndexingFileEntry> {
	const state = await readMemoryIndexingState(input.fs, input.paths);
	const active = requiredActiveFile(state);
	if (active.status !== "verifying") {
		throw new Error(
			`Active memory file ${active.path} must be verifying before completion.`,
		);
	}
	await validateActiveMemoryFile(input.fs, input.repoRoot, input.paths, active);
	const next = updateFile(state, active.path, (entry) => ({
		...entry,
		verificationPassed: true,
		failureReason: null,
	}));
	await writeMemoryIndexingState(input.fs, input.paths, next);
	return requiredActiveFile(next);
}

export async function completeActiveMemoryFile(input: {
	fs: PlannerFs;
	repoRoot: string;
	paths: MemoryStoragePaths;
}): Promise<MemoryIndexingState> {
	const state = await readMemoryIndexingState(input.fs, input.paths);
	const active = requiredActiveFile(state);
	if (!active.verificationPassed) {
		throw new Error(
			`Active memory file ${active.path} has not passed verification.`,
		);
	}
	await validateActiveMemoryFile(input.fs, input.repoRoot, input.paths, active);
	await removeObsoleteFileMemory(
		input.fs,
		input.paths,
		active.path,
		new Set(active.candidateSymbolIds),
	);
	const next = updateFile(state, active.path, (entry) => ({
		...entry,
		status: "indexed",
	}));
	next.activeFile = null;
	await writeMemoryIndexingState(input.fs, input.paths, next);
	return next;
}

export async function ignoreActiveMemoryFile(input: {
	fs: PlannerFs;
	repoRoot: string;
	paths: MemoryStoragePaths;
	kind: MemoryFileKind;
	language: string;
	summary: string;
}): Promise<MemoryIndexingState> {
	const state = await readMemoryIndexingState(input.fs, input.paths);
	const active = requiredActiveFile(state);
	await readUnchangedActiveFile(input.fs, input.repoRoot, active);
	await upsertFileEntries(input.fs, input.paths, [
		{
			path: active.path,
			kind: input.kind,
			language: requiredText(input.language, "language"),
			hash: requiredHash(active),
			status: "ignored",
			summary: requiredText(input.summary, "summary"),
		},
	]);
	await removeObsoleteFileMemory(input.fs, input.paths, active.path, new Set());
	const next = updateFile(state, active.path, (entry) => ({
		...entry,
		status: "ignored",
		verificationPassed: true,
		failureReason: null,
	}));
	next.activeFile = null;
	await writeMemoryIndexingState(input.fs, input.paths, next);
	return next;
}

export function summarizeMemoryIndexing(
	state: MemoryIndexingState,
): MemoryIndexingSummary {
	const count = (status: MemoryIndexingFileStatus) =>
		state.files.filter((entry) => entry.status === status).length;
	const summary = {
		mode: state.mode,
		activeFile: state.activeFile,
		total: state.files.length,
		pending: count("pending"),
		reading: count("reading"),
		verifying: count("verifying"),
		indexed: count("indexed"),
		ignored: count("ignored"),
		missing: count("missing"),
		failed: count("failed"),
		complete: false,
	};
	summary.complete =
		state.mode !== "idle" &&
		state.activeFile === null &&
		summary.pending === 0 &&
		summary.reading === 0 &&
		summary.verifying === 0 &&
		summary.failed === 0;
	return summary;
}

export async function isMemoryIndexingComplete(
	fs: PlannerFs,
	paths: MemoryStoragePaths,
): Promise<boolean> {
	return summarizeMemoryIndexing(await readMemoryIndexingState(fs, paths))
		.complete;
}

async function validateActiveMemoryFile(
	fs: PlannerFs,
	repoRoot: string,
	paths: MemoryStoragePaths,
	active: MemoryIndexingFileEntry,
): Promise<void> {
	assertFullyRead(active);
	const content = await readUnchangedActiveFile(fs, repoRoot, active);
	const file = (await readFileIndex(fs, paths)).find(
		(entry) => entry.path === active.path,
	);
	if (!file || file.hash !== active.hash || file.status !== "indexed") {
		throw new Error(
			`File index entry for ${active.path} must match the active hash before verification.`,
		);
	}
	const symbols = await readSymbolIndex(fs, paths);
	const symbolsById = new Map(symbols.map((symbol) => [symbol.id, symbol]));
	for (const id of active.candidateSymbolIds) {
		const symbol = symbolsById.get(id);
		if (!symbol) {
			throw new Error(`Candidate symbol is missing from memory: ${id}.`);
		}
		if (symbol.path !== active.path) {
			throw new Error(
				`Candidate symbol ${id} does not belong to ${active.path}.`,
			);
		}
		if (symbol.verification.fileHash !== active.hash) {
			throw new Error(`Candidate symbol ${id} has a stale verification hash.`);
		}
		if (!content.includes(symbol.anchor.searchText)) {
			throw new Error(`Candidate symbol ${id} anchor was not found in source.`);
		}
	}
}

async function readUnchangedActiveFile(
	fs: PlannerFs,
	repoRoot: string,
	active: MemoryIndexingFileEntry,
): Promise<string> {
	const content = await fs.readText(join(repoRoot, active.path));
	const actualHash = hashText(content);
	if (actualHash !== active.hash) {
		throw new Error(
			`Active memory file changed during indexing: ${active.path}. Run planner_memory_scan_project again.`,
		);
	}
	if (splitLines(content).length !== active.lineCount) {
		throw new Error(
			`Active memory file line count changed during indexing: ${active.path}.`,
		);
	}
	return content;
}

async function purgeIndexedFile(
	fs: PlannerFs,
	paths: MemoryStoragePaths,
	path: string,
): Promise<void> {
	await removeFileEntries(fs, paths, [path]);
	await removeObsoleteFileMemory(fs, paths, path, new Set());
}

async function removeObsoleteFileMemory(
	fs: PlannerFs,
	paths: MemoryStoragePaths,
	path: string,
	keepSymbolIds: ReadonlySet<string>,
): Promise<void> {
	const symbols = await readSymbolIndex(fs, paths);
	const removedSymbolIds = symbols
		.filter((symbol) => symbol.path === path && !keepSymbolIds.has(symbol.id))
		.map((symbol) => symbol.id);
	if (removedSymbolIds.length > 0) {
		await removeSymbolEntries(fs, paths, removedSymbolIds);
	}
	const removedSet = new Set(removedSymbolIds);
	const relations = await readRelationIndex(fs, paths);
	const relationIds = relations
		.filter(
			(relation) =>
				relation.evidencePath === path ||
				removedSet.has(relation.from) ||
				(relation.to !== null && removedSet.has(relation.to)),
		)
		.map((relation) => relation.id);
	if (relationIds.length > 0) {
		await removeRelationEntries(fs, paths, relationIds);
	}
}

function updateFile(
	state: MemoryIndexingState,
	path: string,
	update: (entry: MemoryIndexingFileEntry) => MemoryIndexingFileEntry,
): MemoryIndexingState {
	return {
		...state,
		files: state.files.map((entry) =>
			entry.path === path ? update(entry) : entry,
		),
	};
}

function requiredActiveFile(
	state: MemoryIndexingState,
): MemoryIndexingFileEntry {
	if (!state.activeFile) {
		throw new Error(
			"Memory indexing has no active file. Claim the next file first.",
		);
	}
	const file = state.files.find((entry) => entry.path === state.activeFile);
	if (!file) {
		throw new Error(
			`Active memory file is missing from queue: ${state.activeFile}.`,
		);
	}
	return file;
}

function pendingFile(
	path: string,
	hash: string,
	lineCount: number,
): MemoryIndexingFileEntry {
	return {
		path,
		hash,
		status: "pending",
		lineCount,
		nextUnreadLine: 1,
		candidateSymbolIds: [],
		verificationPassed: false,
		failureReason: null,
	};
}

function missingFile(path: string): MemoryIndexingFileEntry {
	return {
		path,
		hash: null,
		status: "missing",
		lineCount: 0,
		nextUnreadLine: 1,
		candidateSymbolIds: [],
		verificationPassed: true,
		failureReason: "File is no longer present in the project snapshot.",
	};
}

function failedFile(path: string, reason: string): MemoryIndexingFileEntry {
	return {
		path,
		hash: null,
		status: "failed",
		lineCount: 0,
		nextUnreadLine: 1,
		candidateSymbolIds: [],
		verificationPassed: false,
		failureReason: reason,
	};
}

function splitLines(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split(/\r?\n/);
	if (lines.at(-1) === "") {
		lines.pop();
	}
	return lines;
}

function clampChunkLines(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) {
		return DEFAULT_MEMORY_CHUNK_LINES;
	}
	return Math.min(MAX_MEMORY_CHUNK_LINES, Math.max(1, Math.trunc(value)));
}

function requiredHash(entry: MemoryIndexingFileEntry): string {
	if (!entry.hash) {
		throw new Error(`Memory indexing hash is unavailable for ${entry.path}.`);
	}
	return entry.hash;
}

function assertFullyRead(entry: MemoryIndexingFileEntry): void {
	if (entry.nextUnreadLine <= entry.lineCount) {
		throw new Error(
			`Active memory file ${entry.path} is not fully read. Continue from line ${entry.nextUnreadLine}.`,
		);
	}
}

function assertMemoryIndexingState(state: MemoryIndexingState): void {
	if (!["idle", "initial_discovery", "refresh"].includes(state.mode)) {
		throw new TypeError(`Unsupported memory indexing mode: ${state.mode}.`);
	}
	if (state.activeFile !== null && typeof state.activeFile !== "string") {
		throw new TypeError("Memory indexing activeFile must be a string or null.");
	}
	if (!Array.isArray(state.files)) {
		throw new TypeError("Memory indexing files must be an array.");
	}
	if (
		state.mode === "idle" &&
		(state.activeFile !== null || state.files.length > 0)
	) {
		throw new TypeError(
			"Idle memory indexing state must not contain queued files.",
		);
	}
	const seen = new Set<string>();
	for (const file of state.files) {
		if (!file || typeof file !== "object" || typeof file.path !== "string") {
			throw new TypeError("Memory indexing file entry must have a path.");
		}
		assertSafeRelativePath(file.path);
		if (seen.has(file.path)) {
			throw new TypeError(`Duplicate memory indexing file: ${file.path}.`);
		}
		seen.add(file.path);
		if (!Number.isInteger(file.lineCount) || file.lineCount < 0) {
			throw new TypeError(`Invalid lineCount for ${file.path}.`);
		}
		if (!Number.isInteger(file.nextUnreadLine) || file.nextUnreadLine < 1) {
			throw new TypeError(`Invalid nextUnreadLine for ${file.path}.`);
		}
		if (
			typeof file.status !== "string" ||
			![
				"pending",
				"reading",
				"verifying",
				"indexed",
				"ignored",
				"missing",
				"failed",
			].includes(file.status)
		) {
			throw new TypeError(
				`Unsupported memory indexing status for ${file.path}.`,
			);
		}
		if (file.hash !== null && typeof file.hash !== "string") {
			throw new TypeError(`Invalid memory indexing hash for ${file.path}.`);
		}
		const needsHash = [
			"pending",
			"reading",
			"verifying",
			"indexed",
			"ignored",
		].includes(file.status);
		if (needsHash && (!file.hash || file.hash.trim().length === 0)) {
			throw new TypeError(`Memory indexing hash is required for ${file.path}.`);
		}
		if (!needsHash && file.hash !== null) {
			throw new TypeError(
				`Memory indexing hash must be null for ${file.path}.`,
			);
		}
		if (
			!Array.isArray(file.candidateSymbolIds) ||
			file.candidateSymbolIds.some((id) => typeof id !== "string") ||
			new Set(file.candidateSymbolIds).size !==
				file.candidateSymbolIds.length ||
			file.candidateSymbolIds.some((id) => id.trim().length === 0)
		) {
			throw new TypeError(`Invalid candidate symbols for ${file.path}.`);
		}
		if (typeof file.verificationPassed !== "boolean") {
			throw new TypeError(`Invalid verification flag for ${file.path}.`);
		}
		if (file.failureReason !== null && typeof file.failureReason !== "string") {
			throw new TypeError(`Invalid failure reason for ${file.path}.`);
		}
	}
	if (state.activeFile !== null && !seen.has(state.activeFile)) {
		throw new TypeError(
			`Active memory file is not in queue: ${state.activeFile}.`,
		);
	}
	const inProgress = state.files.filter(
		(file) => file.status === "reading" || file.status === "verifying",
	);
	if (state.activeFile === null && inProgress.length > 0) {
		throw new TypeError(
			"In-progress memory indexing file requires activeFile.",
		);
	}
	if (
		state.activeFile !== null &&
		(inProgress.length !== 1 || inProgress[0]?.path !== state.activeFile)
	) {
		throw new TypeError(
			"activeFile must reference the only reading or verifying memory indexing file.",
		);
	}
}

function assertSafeRelativePath(path: string): void {
	if (
		path.trim().length === 0 ||
		isAbsolute(path) ||
		path.split(/[\\/]/).includes("..")
	) {
		throw new TypeError(
			`Memory indexing path must be safe and relative: ${path}.`,
		);
	}
}

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values.filter((value) => value.trim().length > 0))].sort();
}

function hashText(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function requiredText(value: string, key: string): string {
	if (value.trim().length === 0) {
		throw new TypeError(`${key} must be non-empty.`);
	}
	return value.trim();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
